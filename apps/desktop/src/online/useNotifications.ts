// Realtime-only personal notifications (friend requests/accepts, room
// invites). Each signed-in client subscribes to its own persistent
// `user-inbox:<userId>` channel; senders open a TRANSIENT channel on the
// TARGET's topic, fire one broadcast once subscribed, and remove it.
// Topics differ per user, so a sender's transient channel can never
// collide with its own persistent inbox subscription (the supabase-js
// topic-dedupe footgun documented in the pet-game-online skill).
//
// Deliberately no DB persistence: if the recipient's app isn't open at
// that moment, the notification is simply missed (accepted tradeoff).
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../supabase/client";

export type NotificationKind =
  | "friend_request"
  | "friend_accepted"
  | "room_invite"
  // Control signal only — never shown as a toast/inbox entry. Lets the
  // ORIGINAL inviter clear their "pending" button state the moment the
  // recipient responds, instead of only via the 60s timeout.
  | "room_invite_declined"
  // LOCAL-ONLY: synthesized in GameView from appUpdate.updateState — never
  // sent via sendTo/broadcast, so it's deliberately NOT in the inbound
  // kind-whitelist below. Documented here so the kind namespace stays in
  // one place.
  | "update_ready"
  // Targeted "it's your move" nudge from a chess opponent. Carries
  // groupId + gameId so tapping the toast can deep-link into that room and
  // restore the minimized board.
  | "chess_poke"
  // LOCAL-ONLY (like update_ready): synthesized in GameView from the
  // already-synced chessGames state when a game's currentTurn flips to me —
  // never broadcast, deliberately NOT in the inbound whitelist. Delivered
  // through setLocalToast so it reuses the normal toast TTL/dismiss logic.
  | "chess_turn";

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  fromName: string;
  /** The sender's userId — lets the recipient (or, for declines, the
   *  original inviter) match this notification back to a specific person. */
  fromId: string;
  at: number;
  /** room_invite / room_invite_declined / chess_poke */
  groupId?: string;
  groupName?: string;
  inviteCode?: string;
  /** chess_poke: the chess game to restore on tap (deep-link). */
  gameId?: string;
}

const TOAST_TTL_MS = 6_000;
/** A room invite (and the sender's "pending" button state) auto-cancels for
 *  both sides after this long with no response. */
export const ROOM_INVITE_TTL_MS = 60_000;
const INBOX_MAX = 20;

export interface UseNotifications {
  /** Latest notification, cleared after 6s (or by dismissToast). */
  toast: AppNotification | null;
  /** Session-only rolling log, newest first. */
  inbox: AppNotification[];
  /** The latest room invite, cleared on Join/Dismiss or after 60s. */
  roomInvite: AppNotification | null;
  /** Set whenever a room_invite_declined arrives (manual dismiss OR the
   *  recipient's own 60s timeout) — the inviter watches this to clear its
   *  pending state early instead of waiting out its own 60s timer. */
  lastDecline: { fromId: string; groupId?: string; at: number } | null;
  sendTo: (targetUserId: string, payload: Omit<AppNotification, "id" | "at" | "fromId">) => void;
  /** Show a LOCAL-ONLY toast (update_ready/chess_turn class) through the
   *  exact same toast/TTL/dismiss machinery as realtime kinds — nothing is
   *  ever broadcast. */
  setLocalToast: (payload: Omit<AppNotification, "id" | "at">) => void;
  dismissToast: () => void;
  /** Dismiss the current room invite AND tell the inviter (so their pending
   *  "Invited…" button clears immediately instead of waiting 60s). */
  dismissRoomInvite: () => void;
}

export function useNotifications(userId: string | null, displayName: string): UseNotifications {
  const [toast, setToast] = useState<AppNotification | null>(null);
  const [inbox, setInbox] = useState<AppNotification[]>([]);
  const [roomInvite, setRoomInvite] = useState<AppNotification | null>(null);
  const [lastDecline, setLastDecline] = useState<{ fromId: string; groupId?: string; at: number } | null>(null);
  const displayNameRef = useRef(displayName);
  displayNameRef.current = displayName;

  // Transient sender channels — tracked so unmount can't leak them.
  const pendingSendsRef = useRef(new Set<string>());
  useEffect(() => {
    const pending = pendingSendsRef.current;
    return () => {
      if (!supabase) return;
      for (const topic of pending) {
        const ch = supabase.getChannels().find((c) => c.topic === `realtime:${topic}`);
        if (ch) void supabase.removeChannel(ch);
      }
      pending.clear();
    };
  }, []);

  const sendTo = useCallback(
    (targetUserId: string, payload: Omit<AppNotification, "id" | "at" | "fromId">) => {
      if (!supabase || !userId || targetUserId === userId) return;
      const fullPayload = { ...payload, fromId: userId };
      const topic = `user-inbox:${targetUserId}`;
      // If a previous send to the same target is still open, reuse it —
      // supabase.channel() would hand back that instance anyway (topic
      // dedupe), and calling subscribe() twice on one instance throws.
      const existing = supabase.getChannels().find((c) => c.topic === `realtime:${topic}`);
      if (existing) {
        void existing.send({ type: "broadcast", event: "notify", payload: fullPayload });
        return;
      }
      const channel = supabase.channel(topic, { config: { broadcast: { self: false } } });
      pendingSendsRef.current.add(topic);
      const cleanup = () => {
        pendingSendsRef.current.delete(topic);
        void supabase!.removeChannel(channel);
      };
      channel.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          void channel.send({ type: "broadcast", event: "notify", payload: fullPayload }).finally(() => {
            // Give the relay a beat to flush, then tear the channel down.
            setTimeout(cleanup, 1500);
          });
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          cleanup();
        }
      });
    },
    [userId],
  );
  const sendToRef = useRef(sendTo);
  sendToRef.current = sendTo;

  const declineInvite = useCallback((inv: AppNotification) => {
    sendToRef.current(inv.fromId, {
      kind: "room_invite_declined",
      fromName: displayNameRef.current,
      groupId: inv.groupId,
    });
  }, []);

  // Persistent personal inbox subscription.
  useEffect(() => {
    if (!supabase || !userId) return;
    const channel = supabase.channel(`user-inbox:${userId}`, {
      config: { broadcast: { self: false } },
    });
    channel.on("broadcast", { event: "notify" }, ({ payload }) => {
      const p = payload as Partial<AppNotification> & { kind?: string };
      const fromId = typeof p.fromId === "string" ? p.fromId : "";
      if (p.kind === "room_invite_declined") {
        setLastDecline({ fromId, groupId: p.groupId, at: Date.now() });
        return;
      }
      if (
        p.kind !== "friend_request" &&
        p.kind !== "friend_accepted" &&
        p.kind !== "room_invite" &&
        p.kind !== "chess_poke"
      )
        return;
      const note: AppNotification = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: p.kind,
        fromName: typeof p.fromName === "string" ? p.fromName : "Someone",
        fromId,
        at: Date.now(),
        groupId: typeof p.groupId === "string" ? p.groupId : undefined,
        groupName: typeof p.groupName === "string" ? p.groupName : undefined,
        inviteCode: typeof p.inviteCode === "string" ? p.inviteCode : undefined,
        gameId: typeof p.gameId === "string" ? p.gameId : undefined,
      };
      setToast(note);
      setInbox((prev) => [note, ...prev].slice(0, INBOX_MAX));
      if (note.kind === "room_invite") setRoomInvite(note);
    });
    channel.subscribe();
    return () => {
      void supabase!.removeChannel(channel);
    };
  }, [userId]);

  // Toast TTL housekeeping (same pattern as useRoom's bubble/emote expiry).
  useEffect(() => {
    if (!toast) return;
    const id = setInterval(() => {
      setToast((t) => (t && Date.now() - t.at > TOAST_TTL_MS ? null : t));
    }, 1000);
    return () => clearInterval(id);
  }, [toast]);

  // Room invite TTL: auto-declines (notifying the inviter) after 60s with
  // no response, so a pending invite can't sit open forever on either side.
  useEffect(() => {
    if (!roomInvite) return;
    const id = setInterval(() => {
      setRoomInvite((inv) => {
        if (inv && Date.now() - inv.at > ROOM_INVITE_TTL_MS) {
          declineInvite(inv);
          return null;
        }
        return inv;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [roomInvite, declineInvite]);

  const setLocalToast = useCallback((payload: Omit<AppNotification, "id" | "at">) => {
    const note: AppNotification = {
      ...payload,
      id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      at: Date.now(),
    };
    setToast(note);
    setInbox((prev) => [note, ...prev].slice(0, INBOX_MAX));
  }, []);

  const dismissToast = useCallback(() => setToast(null), []);
  const dismissRoomInvite = useCallback(() => {
    setRoomInvite((inv) => {
      if (inv) declineInvite(inv);
      return null;
    });
  }, [declineInvite]);

  return { toast, inbox, roomInvite, lastDecline, sendTo, setLocalToast, dismissToast, dismissRoomInvite };
}
