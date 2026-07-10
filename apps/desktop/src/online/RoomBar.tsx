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
