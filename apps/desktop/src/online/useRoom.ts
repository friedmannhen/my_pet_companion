// Online room = one Supabase Realtime channel per group (`pet-room:<uuid>`).
// Presence carries the roster (who's here, with which pet); broadcast events
// carry positions, chat, emotes, social pets and the battle handshake. No
// dedicated game server: Realtime relays messages, and anything that must
// agree on both screens (battles) is made deterministic via a shared seed
// resolved by pet-core's resolveBattle on each client independently.
//
// Room security note (MVP): channel names embed the group's UUID — reachable
// only by people who can read the group row (RLS) or were told the id.
// Realtime private-channel authorization is a hardening follow-up.
import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import {
  applyTossEvent,
  currentTossTurn,
  initTossGame,
  resolveBattle,
  TARGET_TOSS_GAME_CODE,
  type BattleResult,
  type BattlerSnapshot,
  type PetSaveData,
  type TossGameCore,
} from "@pet/core";
import { supabase } from "../supabase/client";
import type { GroupInfo } from "../game/useGroups";

export interface RoomMember {
  userId: string;
  name: string;
  petName: string;
  petType: string;
  stage: number;
}

export interface ChatMsg {
  id: string;
  from: string;
  name: string;
  text: string;
  at: number;
}

export interface BattleInvite {
  from: string;
  fromName: string;
  seed: number;
  snapshot: BattlerSnapshot;
  at: number;
}

export interface ActiveBattle {
  seed: number;
  mySide: "a" | "b";
  opponentId: string;
  opponentName: string;
  result: BattleResult;
  startedAt: number;
}

/** ms per battle round in the reveal animation + a beat for the verdict. */
export const BATTLE_ROUND_MS = 1600;
export const BATTLE_VERDICT_MS = 1400;

// ── Minigame: Rock-Paper-Scissors (first minigame, testing the pattern) ─────
// Unlike battles (seed-shared auto-resolve), a minigame takes real player
// input: invite → accept → each side broadcasts its move → both clients
// resolve locally from the same two moves, so outcomes always agree.
export type RpsMove = "rock" | "paper" | "scissors";

export interface MinigameInvite {
  from: string;
  fromName: string;
  at: number;
}

export interface ActiveMinigame {
  opponentId: string;
  opponentName: string;
  myMove: RpsMove | null;
  theirMove: RpsMove | null;
  /** Set once both moves are in — "win"/"lose"/"tie" from MY perspective. */
  outcome: "win" | "lose" | "tie" | null;
}

export function rpsOutcome(mine: RpsMove, theirs: RpsMove): "win" | "lose" | "tie" {
  if (mine === theirs) return "tie";
  const beats: Record<RpsMove, RpsMove> = { rock: "scissors", paper: "rock", scissors: "paper" };
  return beats[mine] === theirs ? "win" : "lose";
}

// ── Room-wide minigame lobby + Target Toss (mg-* events) ────────────────────
// Lobby is host-authoritative pre-start (host rebroadcasts mg-roster as
// ground truth); once mg-start bakes the turn order, NO further host
// authority exists — every client derives turns/phases/winner by running
// pet-core's applyTossEvent reducer over the same ordered mg-throw/mg-skip
// log. All handlers are registered inside join()'s buildAndSubscribe — never
// open a second channel for the same pet-room topic (dedupe footgun).

export const TOSS_TURN_TIMEOUT_MS = 15_000;
/** Grace before the authority client skips a DEPARTED player's turn. */
const TOSS_DEPARTED_SKIP_MS = 3_000;

export interface LobbyInvite {
  hostId: string;
  hostName: string;
  gameCode: string;
  cap: number;
  at: number;
}

export interface MinigameLobby {
  gameCode: string;
  hostId: string;
  hostName: string;
  cap: number;
  /** Join order, host first — becomes the turn order at start. */
  accepted: { userId: string; name: string }[];
  ready: string[];
}

/** Arc replay parameters, normalized to screen fractions (like `pos`). */
export interface TossThrowFx {
  id: string;
  userId: string;
  toNX: number;
  toNY: number;
  arcHeight: number;
  duration: number;
  spinDegrees: number;
  distance: number;
}

export interface TargetTossState {
  core: TossGameCore;
  names: Record<string, string>;
  hostId: string;
  /** Reset on every applied event — drives the AFK countdown. */
  turnStartedAt: number;
  /** Latest throw for all clients to replay; markers accumulate per round. */
  lastFx: TossThrowFx | null;
  /** Current round's landing markers (cleared when the round advances). */
  markers: { userId: string; nx: number; ny: number; distance: number }[];
  /** phase:round key the markers belong to — new key wipes them. */
  markersKey: string;
}

const POS_SEND_MS = 200;
const INVITE_TTL_MS = 30_000;

export interface RoomApi {
  /** The local player's own userId (null while signed out). */
  selfId: string | null;
  activeGroup: GroupInfo | null;
  connected: boolean;
  members: RoomMember[];
  positions: Record<string, { nx: number; ny: number }>;
  bubbles: Record<string, ChatMsg>;
  emotes: Record<string, { emoji: string; at: number }>;
  chatLog: ChatMsg[];
  incomingInvite: BattleInvite | null;
  outgoingInviteTo: string | null;
  battle: ActiveBattle | null;
  incomingGameInvite: MinigameInvite | null;
  outgoingGameInviteTo: string | null;
  minigame: ActiveMinigame | null;
  lobbyInvite: LobbyInvite | null;
  minigameLobby: MinigameLobby | null;
  /** "turned away" / "host left" style lobby feedback. */
  lobbyNotice: string | null;
  tossGame: TargetTossState | null;
  join: (group: GroupInfo) => void;
  leaveRoom: () => void;
  updateMyPosition: (nx: number, ny: number) => void;
  sendChat: (text: string) => void;
  sendEmote: (emoji: string) => void;
  sendSocialPet: (targetUserId: string) => void;
  challenge: (targetUserId: string) => void;
  acceptInvite: () => void;
  declineInvite: () => void;
  clearBattle: () => void;
  inviteMinigame: (targetUserId: string) => void;
  acceptGameInvite: () => void;
  declineGameInvite: () => void;
  sendRpsMove: (move: RpsMove) => void;
  clearMinigame: () => void;
  createMinigameLobby: (cap: number) => void;
  acceptLobbyInvite: () => void;
  declineLobbyInvite: () => void;
  toggleTossReady: () => void;
  startTossGame: () => void;
  cancelMinigameLobby: () => void;
  submitToss: (fx: Omit<TossThrowFx, "id" | "userId">) => void;
  dismissTossGame: () => void;
  clearLobbyNotice: () => void;
}

interface UseRoomOptions {
  userId: string | null;
  displayName: string;
  save: PetSaveData;
  /** Egg-phase pets cannot go online (product rule). */
  isEgg: boolean;
  onSocialPet: (fromName: string) => void;
  onBattleResolved: (won: boolean, opponentName: string) => void;
  onMinigameResolved: (outcome: "win" | "lose" | "tie", opponentName: string) => void;
}

function snapshotOf(save: PetSaveData): BattlerSnapshot {
  return {
    name: save.name,
    stage: save.evolutionStage,
    hunger: save.hunger,
    cleanliness: save.cleanliness,
    happiness: save.happiness,
  };
}

export function useRoom({
  userId,
  displayName,
  save,
  isEgg,
  onSocialPet,
  onBattleResolved,
  onMinigameResolved,
}: UseRoomOptions): RoomApi {
  const [activeGroup, setActiveGroup] = useState<GroupInfo | null>(null);
  const [connected, setConnected] = useState(false);
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [positions, setPositions] = useState<Record<string, { nx: number; ny: number }>>({});
  const [bubbles, setBubbles] = useState<Record<string, ChatMsg>>({});
  const [emotes, setEmotes] = useState<Record<string, { emoji: string; at: number }>>({});
  const [chatLog, setChatLog] = useState<ChatMsg[]>([]);
  const [incomingInvite, setIncomingInvite] = useState<BattleInvite | null>(null);
  const [outgoingInviteTo, setOutgoingInviteTo] = useState<string | null>(null);
  const [battle, setBattle] = useState<ActiveBattle | null>(null);
  const [incomingGameInvite, setIncomingGameInvite] = useState<MinigameInvite | null>(null);
  const [outgoingGameInviteTo, setOutgoingGameInviteTo] = useState<string | null>(null);
  const [minigame, setMinigame] = useState<ActiveMinigame | null>(null);
  const [lobbyInvite, setLobbyInvite] = useState<LobbyInvite | null>(null);
  const [minigameLobby, setMinigameLobby] = useState<MinigameLobby | null>(null);
  const [lobbyNotice, setLobbyNotice] = useState<string | null>(null);
  const [tossGame, setTossGame] = useState<TargetTossState | null>(null);
  // Ref mirrors for the broadcast handlers (registered once per join, so
  // they can't close over fresh state).
  const lobbyRef = useRef<MinigameLobby | null>(null);
  lobbyRef.current = minigameLobby;
  const tossRef = useRef<TargetTossState | null>(null);
  tossRef.current = tossGame;
  const sentLobbyJoinRef = useRef(false);

  const channelRef = useRef<RealtimeChannel | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;
  const nameRef = useRef(displayName);
  nameRef.current = displayName;
  const myPosRef = useRef<{ nx: number; ny: number } | null>(null);
  const lastSentPosRef = useRef<{ nx: number; ny: number } | null>(null);
  const outgoingSnapshotRef = useRef<BattlerSnapshot | null>(null);
  const battleRewardTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onSocialPetRef = useRef(onSocialPet);
  onSocialPetRef.current = onSocialPet;
  const onBattleResolvedRef = useRef(onBattleResolved);
  onBattleResolvedRef.current = onBattleResolved;
  const onMinigameResolvedRef = useRef(onMinigameResolved);
  onMinigameResolvedRef.current = onMinigameResolved;

  // Bumped on every teardown/join so an async-deferred channel build (see
  // join's stale-topic path) can detect it's been superseded and bail —
  // otherwise leaving the room during that window would let the late
  // buildAndSubscribe create a ghost presence in a room the UI already left.
  const joinGenRef = useRef(0);

  const teardown = useCallback(() => {
    joinGenRef.current++;
    if (channelRef.current && supabase) {
      void supabase.removeChannel(channelRef.current);
    }
    channelRef.current = null;
    setActiveGroup(null);
    setConnected(false);
    setMembers([]);
    setPositions({});
    setBubbles({});
    setEmotes({});
    setChatLog([]);
    setIncomingInvite(null);
    setOutgoingInviteTo(null);
    setBattle(null);
    setIncomingGameInvite(null);
    setOutgoingGameInviteTo(null);
    setMinigame(null);
    setLobbyInvite(null);
    setMinigameLobby(null);
    setLobbyNotice(null);
    setTossGame(null);
    sentLobbyJoinRef.current = false;
    if (battleRewardTimer.current) clearTimeout(battleRewardTimer.current);
  }, []);

  useEffect(() => teardown, [teardown]);

  /** Applies one Target Toss throw/skip to local game state (own or remote).
   *  Declared before join() — its broadcast handler closes over this. */
  const applyToss = useCallback(
    (ev: { userId: string; distance: number | null; seq: number }, fx: TossThrowFx | null) => {
      setTossGame((prev) => {
        if (!prev) return prev;
        // Dedupe/order guard: every event carries the sender's seq; anything
        // that doesn't extend our log exactly is a duplicate or stale.
        if (ev.seq !== prev.core.seq) return prev;
        const turn = currentTossTurn(prev.core);
        if (!turn || turn.userId !== ev.userId) return prev;
        const evKey = `${turn.phase}:${turn.round}`;
        const core = applyTossEvent(prev.core, { userId: ev.userId, distance: ev.distance });
        const keep = prev.markersKey === evKey ? prev.markers : [];
        const markers = fx ? [...keep, { userId: ev.userId, nx: fx.toNX, ny: fx.toNY, distance: fx.distance }] : keep;
        return {
          ...prev,
          core,
          markers,
          markersKey: evKey,
          lastFx: fx ?? prev.lastFx,
          turnStartedAt: Date.now(),
        };
      });
    },
    [],
  );

  /** Starts (or schedules) the local battle replay once both sides agree. */
  const beginBattle = useCallback(
    (seed: number, mySide: "a" | "b", a: BattlerSnapshot, b: BattlerSnapshot, opponentId: string, opponentName: string) => {
      const result = resolveBattle(seed, a, b);
      const startedAt = Date.now();
      setBattle({ seed, mySide, opponentId, opponentName, result, startedAt });
      setIncomingInvite(null);
      setOutgoingInviteTo(null);
      const total = result.rounds.length * BATTLE_ROUND_MS + BATTLE_VERDICT_MS;
      if (battleRewardTimer.current) clearTimeout(battleRewardTimer.current);
      battleRewardTimer.current = setTimeout(() => {
        onBattleResolvedRef.current(result.winner === mySide, opponentName);
      }, total);
    },
    [],
  );

  const join = useCallback(
    (group: GroupInfo) => {
      if (!supabase || !userId || isEgg) return;
      teardown();
      // supabase.channel(topic) dedupes by topic: if the groups menu has a
      // read-only presence observer open on this room (SideDock's
      // useGroupPresenceCount), channel() would hand us THAT already-
      // subscribed instance (wrong presence key, subscribe() would throw).
      // Free the topic first and only build our channel once it's gone.
      const topic = `realtime:pet-room:${group.id}`;
      const stale = supabase.getChannels().find((c) => c.topic === topic);
      const buildAndSubscribe = () => {
        const channel = supabase!.channel(`pet-room:${group.id}`, {
          config: { presence: { key: userId }, broadcast: { self: false } },
        });
        channelRef.current = channel;

        channel.on("presence", { event: "sync" }, () => {
          const state = channel.presenceState<RoomMember>();
          const roster: RoomMember[] = [];
          for (const key of Object.keys(state)) {
            const entry = state[key]?.[0];
            if (entry && key !== userId) roster.push(entry);
          }
          setMembers(roster);
          // Drop stale per-user artifacts for anyone who left.
          setPositions((prev) => {
            const next: typeof prev = {};
            for (const m of roster) if (prev[m.userId]) next[m.userId] = prev[m.userId]!;
            return next;
          });
        });

        channel.on("broadcast", { event: "pos" }, ({ payload }) => {
          const p = payload as { from: string; nx: number; ny: number };
          setPositions((prev) => ({ ...prev, [p.from]: { nx: p.nx, ny: p.ny } }));
        });

        channel.on("broadcast", { event: "chat" }, ({ payload }) => {
          const msg = payload as ChatMsg;
          setChatLog((prev) => [...prev.slice(-49), msg]);
          setBubbles((prev) => ({ ...prev, [msg.from]: msg }));
        });

        channel.on("broadcast", { event: "emote" }, ({ payload }) => {
          const p = payload as { from: string; emoji: string };
          setEmotes((prev) => ({ ...prev, [p.from]: { emoji: p.emoji, at: Date.now() } }));
        });

        channel.on("broadcast", { event: "social-pet" }, ({ payload }) => {
          const p = payload as { from: string; fromName: string; to: string };
          if (p.to === userId) onSocialPetRef.current(p.fromName);
        });

        channel.on("broadcast", { event: "battle" }, ({ payload }) => {
          const p = payload as {
            kind: "challenge" | "accept" | "decline";
            from: string;
            fromName: string;
            to: string;
            seed: number;
            snapshot?: BattlerSnapshot;
          };
          if (p.to !== userId) return;
          if (p.kind === "challenge" && p.snapshot) {
            setIncomingInvite({ from: p.from, fromName: p.fromName, seed: p.seed, snapshot: p.snapshot, at: Date.now() });
          } else if (p.kind === "accept" && p.snapshot) {
            // I challenged (side "a", with the snapshot I sent); they accepted with theirs.
            const mine = outgoingSnapshotRef.current ?? snapshotOf(saveRef.current);
            beginBattle(p.seed, "a", mine, p.snapshot, p.from, p.fromName);
          } else if (p.kind === "decline") {
            setOutgoingInviteTo(null);
          }
        });

        // Room-wide minigame lobby + Target Toss event log. One "mg" event
        // with a kind discriminator (functionally the plan's mg-* events).
        channel.on("broadcast", { event: "mg" }, ({ payload }) => {
          const p = payload as {
            kind: "invite" | "join" | "ready" | "roster" | "start" | "throw" | "skip" | "cancel";
            from: string;
            fromName?: string;
            gameCode?: string;
            cap?: number;
            accepted?: { userId: string; name: string }[];
            ready?: string[];
            order?: string[];
            names?: Record<string, string>;
            seq?: number;
            target?: string;
            toNX?: number;
            toNY?: number;
            arcHeight?: number;
            duration?: number;
            spinDegrees?: number;
            distance?: number;
            id?: string;
          };
          if (!userId || p.from === userId) return;

          if (p.kind === "invite") {
            // Room-wide popup — unless I'm already in a lobby/game.
            if (lobbyRef.current || tossRef.current) return;
            setLobbyInvite({
              hostId: p.from,
              hostName: p.fromName ?? "?",
              gameCode: p.gameCode ?? TARGET_TOSS_GAME_CODE,
              cap: p.cap ?? 4,
              at: Date.now(),
            });
            return;
          }

          if (p.kind === "join" || p.kind === "ready") {
            // Host-authoritative: only the host mutates the roster, then
            // rebroadcasts it as ground truth (mirrors the plan's mg-roster).
            const lobby = lobbyRef.current;
            if (!lobby || lobby.hostId !== userId || tossRef.current) return;
            let next = lobby;
            if (p.kind === "join") {
              if (!lobby.accepted.some((a) => a.userId === p.from) && lobby.accepted.length < lobby.cap) {
                next = { ...lobby, accepted: [...lobby.accepted, { userId: p.from, name: p.fromName ?? "?" }] };
              }
            } else {
              const isReady = lobby.ready.includes(p.from);
              const inLobby = lobby.accepted.some((a) => a.userId === p.from);
              if (inLobby) {
                next = { ...lobby, ready: isReady ? lobby.ready.filter((r) => r !== p.from) : [...lobby.ready, p.from] };
              }
            }
            lobbyRef.current = next;
            setMinigameLobby(next);
            // Rebroadcast even when unchanged (e.g. a join past the cap) so
            // the joiner sees a roster without themselves = turned away.
            void channel.send({
              type: "broadcast",
              event: "mg",
              payload: {
                kind: "roster",
                from: userId,
                gameCode: next.gameCode,
                cap: next.cap,
                accepted: next.accepted,
                ready: next.ready,
                hostName: next.hostName,
              },
            });
            return;
          }

          if (p.kind === "roster") {
            const accepted = p.accepted ?? [];
            const amIn = accepted.some((a) => a.userId === userId);
            if (amIn) {
              const lobby: MinigameLobby = {
                gameCode: p.gameCode ?? TARGET_TOSS_GAME_CODE,
                hostId: p.from,
                hostName: (p as { hostName?: string }).hostName ?? "?",
                cap: p.cap ?? accepted.length,
                accepted,
                ready: p.ready ?? [],
              };
              lobbyRef.current = lobby;
              setMinigameLobby(lobby);
              setLobbyInvite(null);
              sentLobbyJoinRef.current = false;
            } else if (sentLobbyJoinRef.current) {
              // I asked to join and the authoritative roster excludes me.
              sentLobbyJoinRef.current = false;
              setLobbyInvite(null);
              setLobbyNotice("That game is full — maybe next round!");
            }
            return;
          }

          if (p.kind === "start") {
            const order = p.order ?? [];
            setLobbyInvite(null);
            lobbyRef.current = null;
            setMinigameLobby(null);
            if (!order.includes(userId)) return; // spectators just drop the popup
            setTossGame({
              core: initTossGame(order),
              names: p.names ?? {},
              hostId: p.from,
              turnStartedAt: Date.now(),
              lastFx: null,
              markers: [],
              markersKey: "main:1",
            });
            return;
          }

          if (p.kind === "throw") {
            applyToss(
              { userId: p.from, distance: p.distance ?? null, seq: p.seq ?? -1 },
              {
                id: p.id ?? `${p.from}-${Date.now()}`,
                userId: p.from,
                toNX: p.toNX ?? 0.5,
                toNY: p.toNY ?? 0.5,
                arcHeight: p.arcHeight ?? 120,
                duration: p.duration ?? 0.8,
                spinDegrees: p.spinDegrees ?? 360,
                distance: p.distance ?? 0,
              },
            );
            return;
          }

          if (p.kind === "skip") {
            if (p.target) applyToss({ userId: p.target, distance: null, seq: p.seq ?? -1 }, null);
            return;
          }

          if (p.kind === "cancel") {
            if (lobbyRef.current?.hostId === p.from) {
              lobbyRef.current = null;
              setMinigameLobby(null);
            }
            setLobbyInvite((inv) => (inv?.hostId === p.from ? null : inv));
          }
        });

        channel.on("broadcast", { event: "minigame" }, ({ payload }) => {
          const p = payload as {
            kind: "invite" | "accept" | "decline" | "move";
            from: string;
            fromName: string;
            to: string;
            move?: RpsMove;
          };
          if (p.to !== userId) return;
          if (p.kind === "invite") {
            setIncomingGameInvite({ from: p.from, fromName: p.fromName, at: Date.now() });
          } else if (p.kind === "accept") {
            setOutgoingGameInviteTo(null);
            setMinigame({ opponentId: p.from, opponentName: p.fromName, myMove: null, theirMove: null, outcome: null });
          } else if (p.kind === "decline") {
            setOutgoingGameInviteTo(null);
          } else if (p.kind === "move" && p.move) {
            setMinigame((prev) => {
              if (!prev || prev.opponentId !== p.from || prev.outcome) return prev;
              const next = { ...prev, theirMove: p.move! };
              return next.myMove ? { ...next, outcome: rpsOutcome(next.myMove, next.theirMove!) } : next;
            });
          }
        });

        channel.subscribe((status) => {
          if (status === "SUBSCRIBED") {
            setConnected(true);
            const s = saveRef.current;
            void channel.track({
              userId,
              name: nameRef.current,
              petName: s.name,
              petType: s.petType,
              stage: s.evolutionStage,
            } satisfies RoomMember);
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            setConnected(false);
          }
        });
      };
      // setActiveGroup runs immediately (not inside buildAndSubscribe) so the
      // UI flips to "in room" without waiting on the stale-channel removal.
      setActiveGroup(group);
      if (stale) {
        // Deferred build: bail if a teardown/re-join superseded this join
        // while the stale observer channel was being removed — a late
        // buildAndSubscribe would otherwise track ghost presence in a room
        // the UI already left.
        const gen = joinGenRef.current;
        void supabase.removeChannel(stale).then(() => {
          if (joinGenRef.current === gen) buildAndSubscribe();
        });
      } else {
        buildAndSubscribe();
      }
    },
    [userId, isEgg, teardown, beginBattle, applyToss],
  );

  // Position publisher: GameView pushes the local pet's normalized position
  // into myPosRef; this interval broadcasts it at ≤5Hz, only when it moved.
  const updateMyPosition = useCallback((nx: number, ny: number) => {
    myPosRef.current = { nx, ny };
  }, []);

  useEffect(() => {
    if (!activeGroup || !connected || !userId) return;
    const id = setInterval(() => {
      const pos = myPosRef.current;
      const last = lastSentPosRef.current;
      if (!pos || !channelRef.current) return;
      if (last && Math.abs(last.nx - pos.nx) < 0.004 && Math.abs(last.ny - pos.ny) < 0.004) return;
      lastSentPosRef.current = pos;
      void channelRef.current.send({
        type: "broadcast",
        event: "pos",
        payload: { from: userId, nx: pos.nx, ny: pos.ny },
      });
    }, POS_SEND_MS);
    return () => clearInterval(id);
  }, [activeGroup, connected, userId]);

  // Housekeeping: expire bubbles (6s), emotes (3s) and stale invites (30s).
  useEffect(() => {
    if (!activeGroup) return;
    const id = setInterval(() => {
      const now = Date.now();
      setBubbles((prev) => {
        const next: typeof prev = {};
        let changed = false;
        for (const k of Object.keys(prev)) {
          if (now - prev[k]!.at < 6000) next[k] = prev[k]!;
          else changed = true;
        }
        return changed ? next : prev;
      });
      setEmotes((prev) => {
        const next: typeof prev = {};
        let changed = false;
        for (const k of Object.keys(prev)) {
          if (now - prev[k]!.at < 3000) next[k] = prev[k]!;
          else changed = true;
        }
        return changed ? next : prev;
      });
      setIncomingInvite((inv) => (inv && now - inv.at > INVITE_TTL_MS ? null : inv));
      setIncomingGameInvite((inv) => (inv && now - inv.at > INVITE_TTL_MS ? null : inv));
    }, 1000);
    return () => clearInterval(id);
  }, [activeGroup]);

  const sendChat = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !channelRef.current || !userId) return;
      const msg: ChatMsg = {
        id: `${userId}-${Date.now()}`,
        from: userId,
        name: nameRef.current,
        text: trimmed.slice(0, 200),
        at: Date.now(),
      };
      // broadcast self:false — apply locally too so my own bubble/log shows.
      setChatLog((prev) => [...prev.slice(-49), msg]);
      setBubbles((prev) => ({ ...prev, [userId]: msg }));
      void channelRef.current.send({ type: "broadcast", event: "chat", payload: msg });
    },
    [userId],
  );

  const sendEmote = useCallback(
    (emoji: string) => {
      if (!channelRef.current || !userId) return;
      setEmotes((prev) => ({ ...prev, [userId]: { emoji, at: Date.now() } }));
      void channelRef.current.send({ type: "broadcast", event: "emote", payload: { from: userId, emoji } });
    },
    [userId],
  );

  const sendSocialPet = useCallback(
    (targetUserId: string) => {
      if (!channelRef.current || !userId) return;
      void channelRef.current.send({
        type: "broadcast",
        event: "social-pet",
        payload: { from: userId, fromName: nameRef.current, to: targetUserId },
      });
    },
    [userId],
  );

  const challenge = useCallback(
    (targetUserId: string) => {
      if (!channelRef.current || !userId || battle) return;
      const snapshot = snapshotOf(saveRef.current);
      outgoingSnapshotRef.current = snapshot;
      setOutgoingInviteTo(targetUserId);
      void channelRef.current.send({
        type: "broadcast",
        event: "battle",
        payload: {
          kind: "challenge",
          from: userId,
          fromName: nameRef.current,
          to: targetUserId,
          seed: Math.floor(Math.random() * 2_147_483_647),
          snapshot,
        },
      });
    },
    [userId, battle],
  );

  const acceptInvite = useCallback(() => {
    const inv = incomingInvite;
    if (!inv || !channelRef.current || !userId) return;
    const mine = snapshotOf(saveRef.current);
    void channelRef.current.send({
      type: "broadcast",
      event: "battle",
      payload: { kind: "accept", from: userId, fromName: nameRef.current, to: inv.from, seed: inv.seed, snapshot: mine },
    });
    // Challenger is always side "a"; I accepted, so I'm "b".
    beginBattle(inv.seed, "b", inv.snapshot, mine, inv.from, inv.fromName);
  }, [incomingInvite, userId, beginBattle]);

  const declineInvite = useCallback(() => {
    const inv = incomingInvite;
    if (!inv || !channelRef.current || !userId) return;
    void channelRef.current.send({
      type: "broadcast",
      event: "battle",
      payload: { kind: "decline", from: userId, fromName: nameRef.current, to: inv.from, seed: inv.seed },
    });
    setIncomingInvite(null);
  }, [incomingInvite, userId]);

  const clearBattle = useCallback(() => setBattle(null), []);

  // ── Minigame verbs ────────────────────────────────────────────────────────
  const inviteMinigame = useCallback(
    (targetUserId: string) => {
      // One game at a time: no RPS while a Target Toss lobby/game is live
      // (mirrors createMinigameLobby's guard in the other direction).
      if (!channelRef.current || !userId || minigame || lobbyRef.current || tossRef.current) return;
      setOutgoingGameInviteTo(targetUserId);
      void channelRef.current.send({
        type: "broadcast",
        event: "minigame",
        payload: { kind: "invite", from: userId, fromName: nameRef.current, to: targetUserId },
      });
    },
    [userId, minigame],
  );

  const acceptGameInvite = useCallback(() => {
    const inv = incomingGameInvite;
    if (!inv || !channelRef.current || !userId) return;
    void channelRef.current.send({
      type: "broadcast",
      event: "minigame",
      payload: { kind: "accept", from: userId, fromName: nameRef.current, to: inv.from },
    });
    setMinigame({ opponentId: inv.from, opponentName: inv.fromName, myMove: null, theirMove: null, outcome: null });
    setIncomingGameInvite(null);
  }, [incomingGameInvite, userId]);

  const declineGameInvite = useCallback(() => {
    const inv = incomingGameInvite;
    if (!inv || !channelRef.current || !userId) return;
    void channelRef.current.send({
      type: "broadcast",
      event: "minigame",
      payload: { kind: "decline", from: userId, fromName: nameRef.current, to: inv.from },
    });
    setIncomingGameInvite(null);
  }, [incomingGameInvite, userId]);

  const sendRpsMove = useCallback(
    (move: RpsMove) => {
      if (!channelRef.current || !userId) return;
      setMinigame((prev) => {
        if (!prev || prev.myMove || prev.outcome) return prev;
        const next = { ...prev, myMove: move };
        return next.theirMove ? { ...next, outcome: rpsOutcome(move, next.theirMove) } : next;
      });
      void channelRef.current.send({
        type: "broadcast",
        event: "minigame",
        payload: { kind: "move", from: userId, fromName: nameRef.current, to: minigame?.opponentId, move },
      });
    },
    [userId, minigame],
  );

  const clearMinigame = useCallback(() => setMinigame(null), []);

  // ── Target Toss lobby + game verbs ───────────────────────────────────────
  const sendMg = useCallback((payload: Record<string, unknown>) => {
    if (!channelRef.current) return;
    void channelRef.current.send({ type: "broadcast", event: "mg", payload });
  }, []);

  const createMinigameLobby = useCallback(
    (cap: number) => {
      if (!channelRef.current || !userId || lobbyRef.current || tossRef.current || minigame) return;
      const lobby: MinigameLobby = {
        gameCode: TARGET_TOSS_GAME_CODE,
        hostId: userId,
        hostName: nameRef.current,
        cap: Math.max(2, cap),
        accepted: [{ userId, name: nameRef.current }],
        ready: [userId], // host is implicitly ready
      };
      lobbyRef.current = lobby;
      setMinigameLobby(lobby);
      setLobbyNotice(null);
      sendMg({ kind: "invite", from: userId, fromName: nameRef.current, gameCode: lobby.gameCode, cap: lobby.cap });
    },
    [userId, minigame, sendMg],
  );

  const acceptLobbyInvite = useCallback(() => {
    const inv = lobbyInvite;
    if (!inv || !channelRef.current || !userId) return;
    sentLobbyJoinRef.current = true;
    sendMg({ kind: "join", from: userId, fromName: nameRef.current });
  }, [lobbyInvite, userId, sendMg]);

  const declineLobbyInvite = useCallback(() => setLobbyInvite(null), []);

  const toggleTossReady = useCallback(() => {
    const lobby = lobbyRef.current;
    if (!lobby || !userId) return;
    if (lobby.hostId === userId) return; // host is always ready
    sendMg({ kind: "ready", from: userId });
  }, [userId, sendMg]);

  const startTossGame = useCallback(() => {
    const lobby = lobbyRef.current;
    if (!lobby || !userId || lobby.hostId !== userId) return;
    if (lobby.accepted.length < 2) return;
    if (!lobby.accepted.every((a) => lobby.ready.includes(a.userId))) return;
    const order = lobby.accepted.map((a) => a.userId);
    const names = Object.fromEntries(lobby.accepted.map((a) => [a.userId, a.name]));
    sendMg({ kind: "start", from: userId, gameCode: lobby.gameCode, order, names });
    setTossGame({
      core: initTossGame(order),
      names,
      hostId: userId,
      turnStartedAt: Date.now(),
      lastFx: null,
      markers: [],
      markersKey: "main:1",
    });
    lobbyRef.current = null;
    setMinigameLobby(null);
  }, [userId, sendMg]);

  const cancelMinigameLobby = useCallback(() => {
    const lobby = lobbyRef.current;
    if (!lobby || !userId || lobby.hostId !== userId) return;
    sendMg({ kind: "cancel", from: userId });
    lobbyRef.current = null;
    setMinigameLobby(null);
  }, [userId, sendMg]);

  const submitToss = useCallback(
    (fx: Omit<TossThrowFx, "id" | "userId">) => {
      const g = tossRef.current;
      if (!g || !userId) return;
      const turn = currentTossTurn(g.core);
      if (!turn || turn.userId !== userId) return;
      const full: TossThrowFx = { ...fx, id: `${userId}-${Date.now()}`, userId };
      sendMg({ kind: "throw", from: userId, seq: g.core.seq, ...full });
      applyToss({ userId, distance: fx.distance, seq: g.core.seq }, full);
    },
    [userId, sendMg, applyToss],
  );

  const skipTossTurn = useCallback(
    (targetId: string) => {
      const g = tossRef.current;
      if (!g || !userId) return;
      const turn = currentTossTurn(g.core);
      if (!turn || turn.userId !== targetId) return;
      sendMg({ kind: "skip", from: userId, seq: g.core.seq, target: targetId });
      applyToss({ userId: targetId, distance: null, seq: g.core.seq }, null);
    },
    [userId, sendMg, applyToss],
  );

  const dismissTossGame = useCallback(() => {
    if (tossRef.current && tossRef.current.core.winners.length > 0) setTossGame(null);
  }, []);

  const clearLobbyNotice = useCallback(() => setLobbyNotice(null), []);

  // AFK handling: the ACTIVE player's own client self-skips after the turn
  // timeout; if the active player has LEFT the room (gone from presence),
  // the first still-present participant in turn order acts as the skip
  // authority after a short grace (host-independent, so a departed host
  // can't stall the game either).
  useEffect(() => {
    if (!tossGame || !userId) return;
    const turn = currentTossTurn(tossGame.core);
    if (!turn) return;
    const id = setInterval(() => {
      const g = tossRef.current;
      if (!g) return;
      const t = currentTossTurn(g.core);
      if (!t) return;
      const elapsed = Date.now() - g.turnStartedAt;
      if (t.userId === userId) {
        if (elapsed >= TOSS_TURN_TIMEOUT_MS) skipTossTurn(userId);
        return;
      }
      const present = (id_: string) => id_ === userId || members.some((m) => m.userId === id_);
      if (!present(t.userId)) {
        const authority = g.core.order.find(present);
        if (authority === userId && elapsed >= TOSS_TURN_TIMEOUT_MS + TOSS_DEPARTED_SKIP_MS) {
          skipTossTurn(t.userId);
        }
      }
    }, 500);
    return () => clearInterval(id);
  }, [tossGame, userId, members, skipTossTurn]);

  // Host disappears from presence before start → lobby auto-cancels locally.
  useEffect(() => {
    if (!minigameLobby || !userId || minigameLobby.hostId === userId) return;
    if (!members.some((m) => m.userId === minigameLobby.hostId)) {
      lobbyRef.current = null;
      setMinigameLobby(null);
      setLobbyNotice("The host left — game lobby closed.");
    }
  }, [members, minigameLobby, userId]);

  // Both moves in → apply the (already-agreed, both clients computed it from
  // the same two moves) outcome exactly once.
  const minigameRewardedRef = useRef(false);
  useEffect(() => {
    if (!minigame?.outcome) {
      minigameRewardedRef.current = false;
      return;
    }
    if (minigameRewardedRef.current) return;
    minigameRewardedRef.current = true;
    onMinigameResolvedRef.current(minigame.outcome, minigame.opponentName);
  }, [minigame]);

  return {
    selfId: userId,
    activeGroup,
    connected,
    members,
    positions,
    bubbles,
    emotes,
    chatLog,
    incomingInvite,
    outgoingInviteTo,
    battle,
    incomingGameInvite,
    outgoingGameInviteTo,
    minigame,
    lobbyInvite,
    minigameLobby,
    lobbyNotice,
    tossGame,
    join,
    leaveRoom: teardown,
    updateMyPosition,
    sendChat,
    sendEmote,
    sendSocialPet,
    challenge,
    acceptInvite,
    declineInvite,
    clearBattle,
    inviteMinigame,
    acceptGameInvite,
    declineGameInvite,
    sendRpsMove,
    clearMinigame,
    createMinigameLobby,
    acceptLobbyInvite,
    declineLobbyInvite,
    toggleTossReady,
    startTossGame,
    cancelMinigameLobby,
    submitToss,
    dismissTossGame,
    clearLobbyNotice,
  };
}
