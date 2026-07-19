// Chess minigame board (Phase 3, polished Jul 2026). Untimed 1:1 games
// persisted in the chess_games table; this panel renders one game from
// room.chessGames.
//
// - Move legality/check/checkmate via chess.js (client-side; the DB only
//   enforces turn ownership — flagged MVP trust tradeoff).
// - Per-player orientation: each viewer sees their own side at the bottom
//   (pure render-side flip; spectators default to White-at-bottom).
// - Kings render as the owning player's LIVE pet sprite (own save for me,
//   presence data for the opponent — same source RemotePets uses), with
//   the existing idle-breathe CSS keyframe. Fallback: the classic glyph.
// - "Give up" resigns (decisive); "Propose cancel" starts the mutual-cancel
//   handshake (no score impact); the unreachable-opponent fallback appears
//   only once the opponent is absent AND the game has been idle past the
//   grace period. Minimizing NEVER forfeits — the panel collapses to a chip
//   (GameView renders the chip) and the game stays live.
// - The panel is MOVABLE (drag by the header — same dragControls handoff
//   pattern as SideDock's tab) and RESIZABLE (↘ corner grip driving a
//   transform: scale() on an inner wrapper — never literal width/height,
//   same rule as the pet's display scale). Position+scale persist to
//   localStorage (mpc_chess_panel_prefs) and clamp back on window resize.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, useDragControls, useMotionValue } from "framer-motion";
import { Chess, type Color, type PieceSymbol, type Square } from "chess.js";
import type { PetSaveData } from "@pet/core";
import { spriteFor, emojiFor } from "../petSprites";
import { Tooltip } from "../Tooltip";
import {
  CHESS_UNREACHABLE_GRACE_MS,
  type ChessGame,
  type ChessMoveEntry,
  type RoomApi,
} from "../../online/useRoom";

const SQUARE = 46;
const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
const PIECE_GLYPHS: Record<Color, Record<PieceSymbol, string>> = {
  w: { p: "♙", n: "♘", b: "♗", r: "♖", q: "♕", k: "♔" },
  b: { p: "♟", n: "♞", b: "♝", r: "♜", q: "♛", k: "♚" },
};

/** Post-poke button lockout — long enough to read "sent", short enough to
 *  re-nudge a genuinely idle opponent. */
const POKE_COOLDOWN_MS = 3_000;

const PANEL_PREFS_KEY = "mpc_chess_panel_prefs";
const PANEL_SCALE_MIN = 0.7;
const PANEL_SCALE_MAX = 1.5;

interface ChessPanelPrefs {
  x: number;
  y: number;
  scale: number;
}

function defaultPanelPrefs(): ChessPanelPrefs {
  return { x: 24, y: Math.max(12, Math.round(window.innerHeight / 2 - 300)), scale: 1 };
}

function loadPanelPrefs(): ChessPanelPrefs {
  try {
    const raw = localStorage.getItem(PANEL_PREFS_KEY);
    if (raw) {
      const p = { ...defaultPanelPrefs(), ...(JSON.parse(raw) as Partial<ChessPanelPrefs>) };
      p.scale = Math.min(PANEL_SCALE_MAX, Math.max(PANEL_SCALE_MIN, p.scale));
      return p;
    }
  } catch {
    /* corrupted — defaults */
  }
  return defaultPanelPrefs();
}

/** Compact relative time for the move list ("now", "2m", "3h", "1d"). */
function timeAgo(iso: string | null): string | null {
  if (!iso) return null;
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const btnStyle: React.CSSProperties = {
  cursor: "pointer",
  border: "none",
  borderRadius: 8,
  padding: "5px 10px",
  fontSize: 11,
  fontWeight: 700,
  background: "rgba(255,255,255,0.1)",
  color: "#fff",
};

function PetKing({ petType, stage, size }: { petType: string; stage: number; size: number }) {
  const src = spriteFor(petType, stage);
  return src ? (
    <img
      src={src}
      width={size}
      height={size}
      draggable={false}
      alt="king"
      className="pet-anim-idle-breathe"
      style={{ display: "block", pointerEvents: "none" }}
    />
  ) : (
    <span style={{ fontSize: size * 0.7, pointerEvents: "none" }}>{emojiFor(petType)}</span>
  );
}

export function ChessPanel({
  room,
  userId,
  mySave,
  game,
  onPoke,
}: {
  room: RoomApi;
  userId: string;
  mySave: PetSaveData;
  game: ChessGame;
  /** Send a "chess_poke" nudge to the opponent (delivered via the personal
   *  user-inbox even if they minimized/left the room). */
  onPoke: (opponentId: string, game: ChessGame) => void;
}) {
  const chess = useMemo(() => {
    try {
      return new Chess(game.fen);
    } catch {
      return new Chess();
    }
  }, [game.fen]);

  const myColor: Color | null = userId === game.playerAId ? "w" : userId === game.playerBId ? "b" : null;
  const isPlayer = myColor !== null;
  const myTurn = isPlayer && game.status === "active" && game.currentTurn === userId;
  const opponentId = !isPlayer ? null : game.playerAId === userId ? game.playerBId : game.playerAId;
  // Viewer orientation: own side at the bottom; spectators see White below.
  const viewColor: Color = myColor ?? "w";

  const nameOf = (id: string): string => {
    if (id === userId) return "You";
    return room.members.find((m) => m.userId === id)?.name ?? "Opponent";
  };
  const petOf = (id: string): { petType: string; stage: number } => {
    if (id === userId) return { petType: mySave.petType, stage: mySave.evolutionStage };
    const m = room.members.find((mm) => mm.userId === id);
    return m ? { petType: m.petType, stage: m.stage } : { petType: "cat", stage: 2 };
  };

  const [selected, setSelected] = useState<Square | null>(null);
  const [confirmResign, setConfirmResign] = useState(false);
  const targets = useMemo(
    () => (selected ? chess.moves({ square: selected, verbose: true }).map((m) => m.to) : []),
    [selected, chess],
  );

  // Shared slow tick: drives the poke-cooldown re-enable AND keeps the
  // move-list relative times fresh (same local-tick pattern as TargetToss).
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 500);
    return () => clearInterval(id);
  }, []);

  // Poke feedback: label flips to "✅ Poke sent" and the button locks for a
  // short cooldown so mashing can't spam the opponent's inbox.
  const [pokeSentAt, setPokeSentAt] = useState<number | null>(null);
  const pokeCooling = pokeSentAt !== null && Date.now() - pokeSentAt < POKE_COOLDOWN_MS;

  // ── Movable + resizable panel ────────────────────────────────────────────
  const initialPrefs = useRef(loadPanelPrefs());
  const panelX = useMotionValue(initialPrefs.current.x);
  const panelY = useMotionValue(initialPrefs.current.y);
  const [panelScale, setPanelScale] = useState(initialPrefs.current.scale);
  const panelScaleRef = useRef(panelScale);
  panelScaleRef.current = panelScale;
  const dragControls = useDragControls();

  const persistPanel = useCallback(() => {
    try {
      localStorage.setItem(
        PANEL_PREFS_KEY,
        JSON.stringify({ x: Math.round(panelX.get()), y: Math.round(panelY.get()), scale: panelScaleRef.current }),
      );
    } catch {
      /* quota */
    }
  }, [panelX, panelY]);

  // Keep the panel reachable if the window shrank since the position was
  // saved (same clamp-on-resize convention as SideDock's tab).
  useEffect(() => {
    const clampNow = () => {
      panelX.set(Math.min(Math.max(panelX.get(), 0), Math.max(0, window.innerWidth - 160)));
      panelY.set(Math.min(Math.max(panelY.get(), 0), Math.max(0, window.innerHeight - 120)));
    };
    clampNow();
    window.addEventListener("resize", clampNow);
    return () => window.removeEventListener("resize", clampNow);
  }, [panelX, panelY]);

  // ↘ corner grip: native pointer drag (single-corner resize doesn't need
  // framer) adjusting a clamped scale factor.
  const onGripPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const startScale = panelScaleRef.current;
    const onMove = (ev: PointerEvent) => {
      const delta = (ev.clientX - startX + (ev.clientY - startY)) / 2;
      setPanelScale(Math.min(PANEL_SCALE_MAX, Math.max(PANEL_SCALE_MIN, startScale + delta / 420)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      persistPanel();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const clickSquare = (sq: Square) => {
    if (!myTurn) return;
    if (selected && (targets as string[]).includes(sq)) {
      // Local legality already proven by the highlight; auto-queen promotion.
      const move = chess.move({ from: selected, to: sq, promotion: "q" });
      setSelected(null);
      if (!move) return;
      const end = chess.isCheckmate()
        ? { winnerId: userId, reason: "checkmate" as const }
        : chess.isDraw()
          ? { winnerId: null, reason: "draw" as const }
          : undefined;
      room.sendChessMove(game.id, move.san, chess.fen(), end);
      return;
    }
    const piece = chess.get(sq);
    setSelected(piece && piece.color === myColor ? sq : null);
  };

  // board() comes back rank 8 → rank 1; flip everything for a Black viewer.
  const boardRows = useMemo(() => {
    const rows = chess.board();
    return viewColor === "w" ? rows : [...rows].reverse().map((row) => [...row].reverse());
  }, [chess, viewColor]);
  const rankLabel = (rowIdx: number) => (viewColor === "w" ? 8 - rowIdx : rowIdx + 1);
  const fileLabel = (colIdx: number) => (viewColor === "w" ? FILES[colIdx] : FILES[7 - colIdx]);
  const squareAt = (rowIdx: number, colIdx: number): Square =>
    `${fileLabel(colIdx)}${rankLabel(rowIdx)}` as Square;

  // ── Numbered, paired move list (auto-scrolls to the newest move) ─────────
  const moveRows = useMemo(() => {
    const rows: { no: number; white: ChessMoveEntry; black: ChessMoveEntry | null }[] = [];
    for (let i = 0; i < game.moveHistory.length; i += 2) {
      rows.push({
        no: i / 2 + 1,
        white: game.moveHistory[i]!,
        black: game.moveHistory[i + 1] ?? null,
      });
    }
    return rows;
  }, [game.moveHistory]);
  const moveListRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = moveListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [game.moveHistory.length]);

  const cancelProposal = room.chessCancelProposals[game.id] ?? null;
  const opponentPresent = !!opponentId && room.members.some((m) => m.userId === opponentId);
  const unreachableEligible =
    isPlayer &&
    game.status === "active" &&
    !!opponentId &&
    !opponentPresent &&
    Date.now() - new Date(game.updatedAt).getTime() > CHESS_UNREACHABLE_GRACE_MS;

  const over = game.status !== "active";
  const resultText = !over
    ? null
    : game.status === "abandoned"
      ? game.resultReason === "mutual_cancel"
        ? "🤝 Game cancelled by mutual agreement — no result recorded."
        : "🕊️ Game cancelled (opponent unreachable) — no result recorded."
      : game.resultReason === "draw"
        ? "🤝 Draw!"
        : game.winnerId === userId
          ? `🏆 You win${game.resultReason === "resignation" ? " — opponent resigned" : " — checkmate"}!`
          : isPlayer
            ? `💔 ${nameOf(game.winnerId ?? "")} wins${game.resultReason === "resignation" ? " — you resigned" : " — checkmate"}.`
            : `🏆 ${nameOf(game.winnerId ?? "")} wins by ${game.resultReason === "resignation" ? "resignation" : "checkmate"}.`;

  const inCheck = game.status === "active" && chess.inCheck();
  const turnName = game.status === "active" ? nameOf(game.currentTurn) : "";

  /** One cell of the move list: SAN + a small dim relative time. */
  const MoveCell = ({ entry }: { entry: ChessMoveEntry | null }) => {
    if (!entry) return <span style={{ opacity: 0.3 }}>…</span>;
    const ago = timeAgo(entry.at);
    return (
      <span style={{ display: "inline-flex", alignItems: "baseline", gap: 4 }}>
        <span>{entry.san}</span>
        {ago && <span style={{ fontSize: 8, opacity: 0.45 }}>{ago}</span>}
      </span>
    );
  };

  return (
    <motion.div
      data-interactive
      drag
      dragControls={dragControls}
      dragListener={false}
      dragMomentum={false}
      dragElastic={0}
      onDragEnd={persistPanel}
      style={{
        position: "fixed",
        left: 0,
        top: 0,
        x: panelX,
        y: panelY,
        // Whole-panel resize via the composed framer transform (never
        // literal width/height): background, header and grip scale together
        // so there's no empty-box/overflow artifact from scaling a child.
        scale: panelScale,
        transformOrigin: "top left",
        zIndex: 21500,
        padding: "14px 16px 16px",
        borderRadius: 16,
        background: "rgba(18,18,26,0.97)",
        color: "#fff",
        boxShadow: "0 12px 40px rgba(0,0,0,0.65)",
        fontFamily: "'Segoe UI', system-ui, sans-serif",
        pointerEvents: "auto",
      }}
    >
      {/* Header: the panel's drag handle (dragControls handoff — same
          pattern as SideDock's tab) + players + status + minimize */}
      <div
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          dragControls.start(e);
        }}
        style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, cursor: "grab", touchAction: "none" }}
      >
        <strong style={{ fontSize: 14, userSelect: "none" }}>
          ♟️ {nameOf(game.playerAId)} (White) vs {nameOf(game.playerBId)} (Black)
        </strong>
        {!isPlayer && (
          <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 999, background: "rgba(96,165,250,0.25)", color: "#93c5fd" }}>
            👁 Watching
          </span>
        )}
        <span style={{ flex: 1 }} />
        <Tooltip label="Minimize — the game keeps running, nothing is forfeited">
          <button
            onClick={room.minimizeChessPanel}
            onPointerDown={(e) => e.stopPropagation()}
            style={{ ...btnStyle, padding: "3px 9px" }}
          >
            ➖
          </button>
        </Tooltip>
        {over && (
          <Tooltip label="Close">
            <button
              onClick={room.closeChessPanel}
              onPointerDown={(e) => e.stopPropagation()}
              style={{ ...btnStyle, padding: "3px 9px" }}
            >
              ✕
            </button>
          </Tooltip>
        )}
      </div>

      <div>
        {/* Status line */}
        <div style={{ fontSize: 12, marginBottom: 8, color: over ? "#fde68a" : myTurn ? "#34d399" : "#e5e7eb" }}>
          {over ? (
            <strong>{resultText}</strong>
          ) : (
            <>
              {myTurn ? "Your move" : `${turnName}'s move`}
              {inCheck && <strong style={{ color: "#f87171" }}> — check!</strong>}
            </>
          )}
        </div>

        {/* Incoming cancel proposal */}
        {cancelProposal && game.status === "active" && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 8,
              padding: "6px 10px",
              borderRadius: 10,
              background: "rgba(251,191,36,0.15)",
              color: "#fde68a",
              fontSize: 12,
            }}
          >
            {nameOf(cancelProposal.from)} proposes cancelling this game (no result for either side).
            <button
              style={{ ...btnStyle, background: "rgba(52,211,153,0.4)" }}
              onClick={() => room.respondChessCancel(game.id, true)}
            >
              Accept
            </button>
            <button style={btnStyle} onClick={() => room.respondChessCancel(game.id, false)}>
              Decline
            </button>
          </div>
        )}

        <div style={{ display: "flex", gap: 12 }}>
          {/* The board (CSS grid) with mirrored algebraic labels */}
          <div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: `16px repeat(8, ${SQUARE}px)`,
                gridTemplateRows: `repeat(8, ${SQUARE}px) 16px`,
                userSelect: "none",
              }}
            >
              {boardRows.map((row, rowIdx) => (
                <Fragment key={`row-${rowIdx}`}>
                  <div
                    style={{ display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, opacity: 0.6 }}
                  >
                    {rankLabel(rowIdx)}
                  </div>
                  {row.map((piece, colIdx) => {
                    const sq = squareAt(rowIdx, colIdx);
                    const dark = (rowIdx + colIdx) % 2 === 1;
                    const isSelected = selected === sq;
                    const isTarget = (targets as string[]).includes(sq);
                    const kingOwner =
                      piece?.type === "k" ? (piece.color === "w" ? game.playerAId : game.playerBId) : null;
                    return (
                      <Tooltip key={sq} label={sq}>
                        <div
                          onClick={() => clickSquare(sq)}
                          style={{
                            width: SQUARE,
                            height: SQUARE,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 30,
                            lineHeight: 1,
                            cursor: myTurn && (isTarget || (piece && piece.color === myColor)) ? "pointer" : "default",
                            background: isSelected
                              ? "rgba(52,211,153,0.55)"
                              : dark
                                ? "#8a6a4f"
                                : "#e6d3ae",
                            boxShadow: isTarget ? "inset 0 0 0 3px rgba(52,211,153,0.85)" : undefined,
                            position: "relative",
                            color: piece?.color === "w" ? "#fafafa" : "#1c1917",
                            textShadow: piece?.color === "w" ? "0 1px 2px rgba(0,0,0,0.7)" : "0 1px 1px rgba(255,255,255,0.25)",
                          }}
                        >
                          {isTarget && !piece && (
                            <span
                              style={{
                                position: "absolute",
                                width: 12,
                                height: 12,
                                borderRadius: "50%",
                                background: "rgba(52,211,153,0.7)",
                              }}
                            />
                          )}
                          {piece &&
                            (kingOwner ? (
                              <PetKing {...petOf(kingOwner)} size={SQUARE - 6} />
                            ) : (
                              PIECE_GLYPHS[piece.color][piece.type]
                            ))}
                        </div>
                      </Tooltip>
                    );
                  })}
                </Fragment>
              ))}
              {/* File labels, mirrored per orientation */}
              <div />
              {Array.from({ length: 8 }, (_, colIdx) => (
                <div
                  key={`file-${colIdx}`}
                  style={{ display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, opacity: 0.6 }}
                >
                  {fileLabel(colIdx)}
                </div>
              ))}
            </div>
          </div>

          {/* Side column: move list + actions */}
          <div style={{ width: 165, display: "flex", flexDirection: "column", gap: 8, fontSize: 11 }}>
            <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
              <div style={{ opacity: 0.55, textTransform: "uppercase", letterSpacing: 0.5, fontSize: 9, marginBottom: 3 }}>
                Moves ({game.moveHistory.length})
              </div>
              {/* Numbered, paired move list — newest at the bottom, kept
                  scrolled there by the effect on moveHistory.length. */}
              <div
                ref={moveListRef}
                className="mpc-no-scrollbar"
                style={{ maxHeight: 170, overflowY: "auto", paddingRight: 2 }}
              >
                {moveRows.length === 0 && <div style={{ opacity: 0.4 }}>No moves yet.</div>}
                {moveRows.map((r) => (
                  <div
                    key={r.no}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "22px 1fr 1fr",
                      gap: 4,
                      padding: "1px 0",
                      alignItems: "baseline",
                    }}
                  >
                    <span style={{ opacity: 0.45 }}>{r.no}.</span>
                    <MoveCell entry={r.white} />
                    <MoveCell entry={r.black} />
                  </div>
                ))}
              </div>
            </div>

            {isPlayer && game.status === "active" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: "auto" }}>
                {!myTurn && opponentId && (
                  <Tooltip
                    label={
                      pokeCooling
                        ? "Poke delivered — give them a moment"
                        : "Nudge your opponent — reaches them even if they minimized the board or left the room (as long as their app is open)"
                    }
                  >
                    <button
                      disabled={pokeCooling}
                      style={{
                        ...btnStyle,
                        background: pokeCooling ? "rgba(52,211,153,0.25)" : "rgba(96,165,250,0.3)",
                        cursor: pokeCooling ? "default" : "pointer",
                        opacity: pokeCooling ? 0.8 : 1,
                      }}
                      onClick={() => {
                        if (pokeCooling) return;
                        onPoke(opponentId, game);
                        setPokeSentAt(Date.now());
                      }}
                    >
                      {pokeCooling ? "✅ Poke sent" : `👉 Poke ${nameOf(opponentId)}`}
                    </button>
                  </Tooltip>
                )}
                {confirmResign ? (
                  <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
                    <span style={{ color: "#fca5a5" }}>Really?</span>
                    <button
                      style={{ ...btnStyle, background: "rgba(248,113,113,0.5)" }}
                      onClick={() => {
                        setConfirmResign(false);
                        room.resignChess(game.id);
                      }}
                    >
                      Yes, resign
                    </button>
                    <button style={btnStyle} onClick={() => setConfirmResign(false)}>
                      No
                    </button>
                  </div>
                ) : (
                  <Tooltip label="Resign — counts as a loss for you and a win for your opponent">
                    <button
                      style={{ ...btnStyle, background: "rgba(248,113,113,0.2)", color: "#fca5a5" }}
                      onClick={() => setConfirmResign(true)}
                    >
                      🏳️ Give up
                    </button>
                  </Tooltip>
                )}
                <Tooltip label="Propose ending the game with no result for either side — only happens if your opponent accepts">
                  <button style={btnStyle} onClick={() => room.proposeChessCancel(game.id)}>
                    🤝 Propose cancel
                  </button>
                </Tooltip>
                {unreachableEligible && (
                  <Tooltip label="Your opponent has been away for a long time — end the game with no result for either side">
                    <button
                      style={{ ...btnStyle, background: "rgba(251,191,36,0.2)", color: "#fde68a" }}
                      onClick={() => room.cancelChessUnreachable(game.id)}
                    >
                      🕊️ Cancel — opponent unreachable
                    </button>
                  </Tooltip>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ↘ resize grip (native pointer drag — adjusts the content scale) */}
      <Tooltip label="Drag to resize the board">
        <div
          onPointerDown={onGripPointerDown}
          style={{
            position: "absolute",
            right: 2,
            bottom: 2,
            width: 18,
            height: 18,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "nwse-resize",
            fontSize: 11,
            opacity: 0.55,
            userSelect: "none",
            touchAction: "none",
          }}
        >
          ↘
        </div>
      </Tooltip>
    </motion.div>
  );
}
