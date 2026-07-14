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

export type NotificationKind = "friend_request" | "friend_accepted" | "room_invite";

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  fromName: string;
  at: number;
  /** room_invite only */
  groupId?: string;
  groupName?: string;
  inviteCode?: string;
}

const TOAST_TTL_MS = 6_000;
const INBOX_MAX = 20;

export interface UseNotifications {
  /** Latest notification, cleared after 6s (or by dismissToast). */
  toast: AppNotification | null;
  /** Session-only rolling log, newest first. */
  inbox: AppNotification[];
  /** The latest room invite, held until acted on (not TTL'd like the toast). */
  roomInvite: AppNotification | null;
  sendTo: (targetUserId: string, payload: Omit<AppNotification, "id" | "at">) => void;
  dismissToast: () => void;
  dismissRoomInvite: () => void;
}

export function useNotifications(userId: string | null): UseNotifications {
  const [toast, setToast] = useState<AppNotification | null>(null);
  const [inbox, setInbox] = useState<AppNotification[]>([]);
  const [roomInvite, setRoomInvite] = useState<AppNotification | null>(null);

  // Persistent personal inbox subscription.
  useEffect(() => {
    if (!supabase || !userId) return;
    const channel = supabase.channel(`user-inbox:${userId}`, {
      config: { broadcast: { self: false } },
    });
    channel.on("broadcast", { event: "notify" }, ({ payload }) => {
      const p = payload as Partial<AppNotification> & { kind?: string };
      if (p.kind !== "friend_request" && p.kind !== "friend_accepted" && p.kind !== "room_invite") return;
      const note: AppNotification = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: p.kind,
        fromName: typeof p.fromName === "string" ? p.fromName : "Someone",
        at: Date.now(),
        groupId: typeof p.groupId === "string" ? p.groupId : undefined,
        groupName: typeof p.groupName === "string" ? p.groupName : undefined,
        inviteCode: typeof p.inviteCode === "string" ? p.inviteCode : undefined,
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
    (targetUserId: string, payload: Omit<AppNotification, "id" | "at">) => {
      if (!supabase || !userId || targetUserId === userId) return;
      const topic = `user-inbox:${targetUserId}`;
      // If a previous send to the same target is still open, reuse it —
      // supabase.channel() would hand back that instance anyway (topic
      // dedupe), and calling subscribe() twice on one instance throws.
      const existing = supabase.getChannels().find((c) => c.topic === `realtime:${topic}`);
      if (existing) {
        void existing.send({ type: "broadcast", event: "notify", payload });
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
          void channel.send({ type: "broadcast", event: "notify", payload }).finally(() => {
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

  const dismissToast = useCallback(() => setToast(null), []);
  const dismissRoomInvite = useCallback(() => setRoomInvite(null), []);

  return { toast, inbox, roomInvite, sendTo, dismissToast, dismissRoomInvite };
}
