// Friends' pets living on YOUR desktop while you share a room. Positions
// arrive as normalized (0..1) screen fractions — every member sees the same
// relative layout regardless of monitor size — and are eased with springs so
// 5Hz network updates read as smooth strolls, not teleports. Clicking a
// remote pet opens a tiny action menu: pet it (sends hearts to its owner)
// or challenge it to a battle.
import { useState } from "react";
import { motion, useSpring } from "framer-motion";
import { spriteFor, emojiFor } from "../game/petSprites";
import type { RoomApi, RoomMember } from "./useRoom";

const REMOTE_SIZE = 104;

function RemotePet({
  member,
  nx,
  ny,
  bubble,
  emote,
  room,
  busy,
}: {
  member: RoomMember;
  nx: number;
  ny: number;
  bubble: string | null;
  emote: string | null;
  room: RoomApi;
  busy: boolean;
}) {
  const targetX = nx * window.innerWidth - REMOTE_SIZE / 2;
  const targetY = ny * window.innerHeight - REMOTE_SIZE / 2;
  const x = useSpring(targetX, { stiffness: 60, damping: 18 });
  const y = useSpring(targetY, { stiffness: 60, damping: 18 });
  x.set(targetX);
  y.set(targetY);
  const [menuOpen, setMenuOpen] = useState(false);

  const sprite = spriteFor(member.petType, member.stage);

  return (
    <motion.div
      data-interactive
      style={{
        position: "fixed",
        left: 0,
        top: 0,
        x,
        y,
        width: REMOTE_SIZE,
        height: REMOTE_SIZE,
        zIndex: 18000,
        cursor: "pointer",
      }}
      onClick={() => setMenuOpen((o) => !o)}
    >
      {/* Name tag */}
      <div
        style={{
          position: "absolute",
          top: -22,
          left: "50%",
          transform: "translateX(-50%)",
          whiteSpace: "nowrap",
          fontSize: 10,
          fontWeight: 700,
          padding: "2px 8px",
          borderRadius: 999,
          background: "rgba(20,20,26,0.8)",
          color: "#93c5fd",
          pointerEvents: "none",
          fontFamily: "'Segoe UI', system-ui, sans-serif",
        }}
      >
        {member.petName} · {member.name}
      </div>

      {/* Chat bubble */}
      {bubble && (
        <div
          style={{
            position: "absolute",
            bottom: REMOTE_SIZE + 4,
            left: "50%",
            transform: "translateX(-50%)",
            maxWidth: 220,
            fontSize: 12,
            padding: "6px 10px",
            borderRadius: 12,
            background: "rgba(255,255,255,0.95)",
            color: "#1f2937",
            pointerEvents: "none",
            fontFamily: "'Segoe UI', system-ui, sans-serif",
            boxShadow: "0 3px 10px rgba(0,0,0,0.35)",
          }}
        >
          {bubble}
        </div>
      )}

      {/* Emote burst */}
      {emote && (
        <motion.div
          key={emote + member.userId}
          initial={{ opacity: 0, y: 0, scale: 0.5 }}
          animate={{ opacity: [0, 1, 1, 0], y: -40, scale: 1.4 }}
          transition={{ duration: 2 }}
          style={{
            position: "absolute",
            top: -14,
            left: "50%",
            transform: "translateX(-50%)",
            fontSize: 26,
            pointerEvents: "none",
          }}
        >
          {emote}
        </motion.div>
      )}

      {/* The pet — slightly translucent so it's clearly a visitor. */}
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", opacity: 0.92 }}>
        {sprite ? (
          <img src={sprite} width={REMOTE_SIZE} height={REMOTE_SIZE} draggable={false} alt={member.petName} />
        ) : (
          <span style={{ fontSize: 64 }}>{emojiFor(member.petType)}</span>
        )}
      </div>

      {/* Interaction mini-menu */}
      {menuOpen && (
        <div
          style={{
            position: "absolute",
            top: REMOTE_SIZE - 6,
            left: "50%",
            transform: "translateX(-50%)",
            display: "flex",
            gap: 6,
            padding: 6,
            borderRadius: 10,
            background: "rgba(22,22,28,0.94)",
            boxShadow: "0 4px 14px rgba(0,0,0,0.5)",
          }}
        >
          <button
            title={`Pet ${member.petName}`}
            style={{ cursor: "pointer", border: "none", borderRadius: 7, padding: "5px 9px", fontSize: 14, background: "rgba(255,255,255,0.12)" }}
            onClick={(e) => {
              e.stopPropagation();
              room.sendSocialPet(member.userId);
              room.sendEmote("🤗");
              setMenuOpen(false);
            }}
          >
            🤗
          </button>
          <button
            title={busy ? "Battle already in progress" : `Challenge ${member.petName} to a battle`}
            disabled={busy}
            style={{
              cursor: busy ? "default" : "pointer",
              border: "none",
              borderRadius: 7,
              padding: "5px 9px",
              fontSize: 14,
              background: "rgba(248,113,113,0.3)",
              opacity: busy ? 0.4 : 1,
            }}
            onClick={(e) => {
              e.stopPropagation();
              room.challenge(member.userId);
              setMenuOpen(false);
            }}
          >
            ⚔️
          </button>
        </div>
      )}
    </motion.div>
  );
}

export function RemotePets({ room }: { room: RoomApi }) {
  if (!room.activeGroup) return null;
  const busy = room.battle !== null || room.outgoingInviteTo !== null;
  return (
    <>
      {room.members.map((m) => {
        const pos = room.positions[m.userId];
        if (!pos) return null;
        const bubble = room.bubbles[m.userId];
        const emote = room.emotes[m.userId];
        return (
          <RemotePet
            key={m.userId}
            member={m}
            nx={pos.nx}
            ny={pos.ny}
            bubble={bubble && Date.now() - bubble.at < 6000 ? bubble.text : null}
            emote={emote ? emote.emoji : null}
            room={room}
            busy={busy}
          />
        );
      })}
    </>
  );
}
