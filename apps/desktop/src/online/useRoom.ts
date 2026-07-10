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
  resolveBattle,
  type BattleResult,
  type BattlerSnapshot,
  type PetSaveData,
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

const POS_SEND_MS = 200;
const INVITE_TTL_MS = 30_000;

export interface RoomApi {
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
}

interface UseRoomOptions {
  userId: string | null;
  displayName: string;
  save: PetSaveData;
  /** Egg-phase pets cannot go online (product rule). */
  isEgg: boolean;
  onSocialPet: (fromName: string) => void;
  onBattleResolved: (won: boolean, opponentName: string) => void;
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

  const teardown = useCallback(() => {
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
    if (battleRewardTimer.current) clearTimeout(battleRewardTimer.current);
  }, []);

  useEffect(() => teardown, [teardown]);

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
      const channel = supabase.channel(`pet-room:${group.id}`, {
        config: { presence: { key: userId }, broadcast: { self: false } },
      });
      channelRef.current = channel;
      setActiveGroup(group);

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
    },
    [userId, isEgg, teardown, beginBattle],
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

  return {
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
  };
}
