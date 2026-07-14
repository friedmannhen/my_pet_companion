// Compact bottom-center bar shown while in an online room: room name +
// member count, emote buttons, expandable chat input, battle
// invite/progress banners, and Leave. The chat input needs real OS keyboard
// focus (the overlay is non-focusable by default), so focus is granted only
// while the chat box is expanded — the same bounded-interaction pattern as
// wash-scrub and the settings inputs.
import { useEffect, useRef, useState } from "react";
import { BATTLE_ROUND_MS, BATTLE_VERDICT_MS, type RoomApi } from "./useRoom";

const EMOTES = ["👋", "❤️", "😂", "😮", "😢", "🎉"];

const barBtn: React.CSSProperties = {
  cursor: "pointer",
  border: "none",
  borderRadius: 7,
  padding: "4px 8px",
  fontSize: 13,
  background: "rgba(255,255,255,0.12)",
  color: "#fff",
};

export function RoomBar({ room }: { room: RoomApi }) {
  const [chatOpen, setChatOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [gamePickerOpen, setGamePickerOpen] = useState(false);
  const [gameCap, setGameCap] = useState(4);
  const inputRef = useRef<HTMLInputElement>(null);
  // Rerender tick while a battle reveal is playing.
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!chatOpen) return;
    window.overlay.setFocusable(true);
    const t = setTimeout(() => inputRef.current?.focus(), 60);
    return () => {
      clearTimeout(t);
      window.overlay.setFocusable(false);
    };
  }, [chatOpen]);

  useEffect(() => {
    if (!room.battle) return;
    const id = setInterval(() => setTick((t) => t + 1), 400);
    return () => clearInterval(id);
  }, [room.battle]);

  if (!room.activeGroup) return null;

  const send = () => {
    room.sendChat(draft);
    setDraft("");
  };

  // Battle reveal: how many rounds are visible by now, then the verdict.
  let battleLine: string | null = null;
  if (room.battle) {
    const { result, startedAt, mySide, opponentName } = room.battle;
    const elapsed = Date.now() - startedAt;
    const shown = Math.min(result.rounds.length, Math.floor(elapsed / BATTLE_ROUND_MS) + 1);
    const round = result.rounds[shown - 1];
    if (elapsed >= result.rounds.length * BATTLE_ROUND_MS + BATTLE_VERDICT_MS) {
      room.clearBattle();
    } else if (elapsed >= result.rounds.length * BATTLE_ROUND_MS) {
      battleLine = result.winner === mySide ? `🏆 You won against ${opponentName}!` : `💔 ${opponentName} won this time…`;
    } else if (round) {
      const iWon = round.winner === mySide;
      battleLine = `⚔️ Round ${shown}/${result.rounds.length}: ${round.move} — ${iWon ? "you take it!" : `${opponentName} takes it!`}`;
    }
  }

  return (
    <div
      data-interactive
      style={{
        position: "fixed",
        bottom: 10,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 23000,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 6,
        fontFamily: "'Segoe UI', system-ui, sans-serif",
      }}
    >
      {/* Battle invite banner */}
      {room.incomingInvite && !room.battle && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 12px",
            borderRadius: 12,
            background: "rgba(120,40,40,0.95)",
            color: "#fff",
            fontSize: 13,
            boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
          }}
        >
          ⚔️ {room.incomingInvite.fromName} challenges your pet!
          <button style={{ ...barBtn, background: "rgba(52,211,153,0.85)", color: "#06281c", fontWeight: 700 }} onClick={room.acceptInvite}>
            Accept
          </button>
          <button style={barBtn} onClick={room.declineInvite}>
            Decline
          </button>
        </div>
      )}
      {room.outgoingInviteTo && !room.battle && (
        <div style={{ padding: "6px 12px", borderRadius: 10, background: "rgba(20,20,26,0.85)", color: "#fde68a", fontSize: 12 }}>
          ⚔️ Challenge sent — waiting for an answer…
        </div>
      )}
      {battleLine && (
        <div
          style={{
            padding: "8px 14px",
            borderRadius: 12,
            background: "rgba(30,20,60,0.95)",
            color: "#fff",
            fontSize: 13,
            fontWeight: 700,
            boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
          }}
        >
          {battleLine}
        </div>
      )}

      {/* Minigame: RPS invite banner */}
      {room.incomingGameInvite && !room.minigame && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 12px",
            borderRadius: 12,
            background: "rgba(30,58,95,0.95)",
            color: "#fff",
            fontSize: 13,
            boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
          }}
        >
          🎮 {room.incomingGameInvite.fromName} wants to play Rock-Paper-Scissors!
          <button
            style={{ ...barBtn, background: "rgba(52,211,153,0.85)", color: "#06281c", fontWeight: 700 }}
            onClick={room.acceptGameInvite}
          >
            Play
          </button>
          <button style={barBtn} onClick={room.declineGameInvite}>
            Not now
          </button>
        </div>
      )}
      {room.outgoingGameInviteTo && !room.minigame && (
        <div style={{ padding: "6px 12px", borderRadius: 10, background: "rgba(20,20,26,0.85)", color: "#93c5fd", fontSize: 12 }}>
          🎮 Game invite sent — waiting…
        </div>
      )}

      {/* The RPS pick/reveal UI lives in the full-screen RockPaperScissors
          modal now — RoomBar only shows the pre-game invite banners above. */}

      {/* Lobby feedback toast (turned away / host left) */}
      {room.lobbyNotice && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 12px",
            borderRadius: 10,
            background: "rgba(120,53,15,0.95)",
            color: "#fde68a",
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          {room.lobbyNotice}
          <button style={barBtn} onClick={room.clearLobbyNotice}>
            ✕
          </button>
        </div>
      )}

      {/* Room-wide minigame lobby invite */}
      {room.lobbyInvite && !room.minigameLobby && !room.tossGame && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 12px",
            borderRadius: 12,
            background: "rgba(6,78,59,0.95)",
            color: "#fff",
            fontSize: 13,
            boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
          }}
        >
          🎯 {room.lobbyInvite.hostName} is starting Target Toss (up to {room.lobbyInvite.cap} players)!
          <button
            style={{ ...barBtn, background: "rgba(52,211,153,0.85)", color: "#06281c", fontWeight: 700 }}
            onClick={room.acceptLobbyInvite}
          >
            Join
          </button>
          <button style={barBtn} onClick={room.declineLobbyInvite}>
            Not now
          </button>
        </div>
      )}

      {/* Lobby roster / ready / start panel */}
      {room.minigameLobby && !room.tossGame && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: "10px 14px",
            borderRadius: 12,
            background: "rgba(20,20,26,0.95)",
            color: "#fff",
            fontSize: 12,
            boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
            minWidth: 240,
          }}
        >
          <div style={{ fontWeight: 800 }}>
            🎯 Target Toss lobby — {room.minigameLobby.accepted.length}/{room.minigameLobby.cap} players
          </div>
          {room.minigameLobby.accepted.map((a) => (
            <div key={a.userId} style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
              <span>
                {a.name}
                {a.userId === room.minigameLobby!.hostId && " 👑"}
              </span>
              <span style={{ opacity: 0.85 }}>{room.minigameLobby!.ready.includes(a.userId) ? "✅ ready" : "…"}</span>
            </div>
          ))}
          <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
            {room.minigameLobby.hostId === room.selfId ? (
              <>
                <button
                  disabled={
                    room.minigameLobby.accepted.length < 2 ||
                    !room.minigameLobby.accepted.every((a) => room.minigameLobby!.ready.includes(a.userId))
                  }
                  style={{
                    ...barBtn,
                    background: "rgba(52,211,153,0.85)",
                    color: "#06281c",
                    fontWeight: 700,
                    opacity:
                      room.minigameLobby.accepted.length >= 2 &&
                        room.minigameLobby.accepted.every((a) => room.minigameLobby!.ready.includes(a.userId))
                        ? 1
                        : 0.45,
                  }}
                  onClick={room.startTossGame}
                >
                  ▶ Start
                </button>
                <button style={{ ...barBtn, background: "rgba(248,113,113,0.3)" }} onClick={room.cancelMinigameLobby}>
                  Cancel
                </button>
              </>
            ) : (
              <button
                style={{
                  ...barBtn,
                  background: room.minigameLobby.ready.includes(room.selfId ?? "")
                    ? "rgba(52,211,153,0.5)"
                    : (barBtn.background as string),
                  fontWeight: 700,
                }}
                onClick={room.toggleTossReady}
              >
                {room.minigameLobby.ready.includes(room.selfId ?? "") ? "✅ Ready" : "Ready up"}
              </button>
            )}
            <span style={{ fontSize: 10, opacity: 0.55, alignSelf: "center" }}>
              {room.minigameLobby.hostId === room.selfId ? "Starts when everyone is ready" : "Waiting for the host…"}
            </span>
          </div>
        </div>
      )}

      {/* Game picker (host-side entry point) */}
      {gamePickerOpen && !room.minigameLobby && !room.tossGame && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 12px",
            borderRadius: 12,
            background: "rgba(20,20,26,0.95)",
            color: "#fff",
            fontSize: 12,
            boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
          }}
        >
          <span style={{ fontWeight: 700 }}>🎯 Target Toss</span>
          <span style={{ opacity: 0.7 }}>max players:</span>
          {[2, 3, 4].map((n) => (
            <button
              key={n}
              style={{ ...barBtn, background: gameCap === n ? "rgba(52,211,153,0.5)" : barBtn.background as string }}
              onClick={() => setGameCap(n)}
            >
              {n}
            </button>
          ))}
          <button
            style={{ ...barBtn, background: "rgba(52,211,153,0.85)", color: "#06281c", fontWeight: 700 }}
            onClick={() => {
              room.createMinigameLobby(gameCap);
              setGamePickerOpen(false);
            }}
          >
            Invite room
          </button>
          <button style={barBtn} onClick={() => setGamePickerOpen(false)}>
            ✕
          </button>
        </div>
      )}

      {/* Chat input (expanded) */}
      {chatOpen && (
        <div style={{ display: "flex", gap: 6 }}>
          <input
            ref={inputRef}
            value={draft}
            maxLength={200}
            placeholder="Say something…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") send();
              if (e.key === "Escape") setChatOpen(false);
            }}
            style={{
              width: 260,
              border: "1px solid rgba(255,255,255,0.2)",
              borderRadius: 8,
              padding: "6px 10px",
              fontSize: 13,
              background: "rgba(20,20,26,0.92)",
              color: "#fff",
              outline: "none",
            }}
          />
          <button style={barBtn} onClick={send}>
            Send
          </button>
        </div>
      )}

      {/* Main bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 10px",
          borderRadius: 12,
          background: "rgba(20,20,26,0.9)",
          color: "#fff",
          boxShadow: "0 4px 16px rgba(0,0,0,0.45)",
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 700, color: room.connected ? "#34d399" : "#fbbf24" }}>
          🌐 {room.activeGroup.name}
        </span>
        <span style={{ fontSize: 11, opacity: 0.7 }}>
          {room.members.length + 1} here
        </span>
        <span style={{ width: 1, height: 16, background: "rgba(255,255,255,0.15)" }} />
        {EMOTES.map((e) => (
          <button key={e} style={{ ...barBtn, padding: "3px 5px" }} title="Send emote" onClick={() => room.sendEmote(e)}>
            {e}
          </button>
        ))}
        <span style={{ width: 1, height: 16, background: "rgba(255,255,255,0.15)" }} />
        <button
          style={barBtn}
          title={room.minigameLobby || room.tossGame ? "A game is already going" : "Mini-games"}
          disabled={!!room.minigameLobby || !!room.tossGame}
          onClick={() => setGamePickerOpen((o) => !o)}
        >
          🎯
        </button>
        <button style={barBtn} title="Chat" onClick={() => setChatOpen((o) => !o)}>
          💬
        </button>
        <button style={{ ...barBtn, background: "rgba(248,113,113,0.3)" }} title="Leave room" onClick={room.leaveRoom}>
          Leave
        </button>
      </div>
    </div>
  );
}
