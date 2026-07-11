// Session lease client (plan §12): acquires the single "live" lease for this
// user on sign-in, heartbeats it while active, and releases on clean close.
// A conflict is surfaced (never auto-resolved) — the player explicitly
// chooses to force takeover, per the plan's recommended default.
//
// Two distinct situations both used to collapse into one "conflict" status,
// which is why force-takeover looked like a no-op from the ousted device's
// point of view: nothing there ever told it "you were just kicked," it just
// showed the same "take over" button the *other* (new) device sees when
// blocked at acquire time. Kept as separate statuses on purpose:
//   - "conflict": this device tried to acquire and another was already
//     active — the player can force takeover to claim it.
//   - "kicked": this device WAS the active one and lost the lease (another
//     device forced takeover) — surfaced distinctly so the UI can make it
//     unmistakable this session got booted, not just offer a generic button.
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../supabase/client";

export type LeaseStatus = "idle" | "acquiring" | "active" | "conflict" | "kicked" | "error";

export interface LeaseConflict {
  deviceType: string;
  acquiredAt: string;
}

export interface SessionLease {
  status: LeaseStatus;
  conflict: LeaseConflict | null;
  error: string | null;
  forceTakeover: () => void;
}

const DEVICE_TYPE = "desktop";
const HEARTBEAT_MS = 20_000;

export function useSessionLease(userId: string | null): SessionLease {
  const [status, setStatus] = useState<LeaseStatus>("idle");
  const [conflict, setConflict] = useState<LeaseConflict | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sessionIdRef = useRef<string>(crypto.randomUUID());

  const callFn = useCallback(async (name: string, body: object) => {
    if (!supabase) throw new Error("no backend");
    const { data, error } = await supabase.functions.invoke(name, { body });
    if (error) throw error;
    return data;
  }, []);

  const acquire = useCallback(
    async (force: boolean) => {
      if (!userId) return;
      setStatus("acquiring");
      setError(null);
      try {
        const res = await callFn("acquire-session", {
          sessionId: sessionIdRef.current,
          deviceType: DEVICE_TYPE,
          force,
        });
        if (res.granted) {
          setStatus("active");
          setConflict(null);
        } else {
          setStatus("conflict");
          setConflict(res.conflict ?? null);
        }
      } catch (err) {
        setStatus("error");
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [userId, callFn],
  );

  useEffect(() => {
    if (!userId) {
      setStatus("idle");
      return;
    }
    void acquire(false);
  }, [userId, acquire]);

  // Heartbeat while active.
  useEffect(() => {
    if (status !== "active" || !userId) return;
    const id = setInterval(() => {
      void (async () => {
        try {
          const res = await callFn("heartbeat-session", { sessionId: sessionIdRef.current });
          if (!res.ok) {
            // This device WAS the active one and just lost the lease to a
            // takeover elsewhere — distinct from "conflict" (blocked at
            // acquire time), so the UI can make it unmistakable.
            setStatus("kicked");
            setConflict({ deviceType: "another device", acquiredAt: new Date().toISOString() });
          }
        } catch {
          // Transient network errors don't drop the session — the server
          // side grace window (LEASE_TTL_MS) tolerates missed heartbeats.
        }
      })();
    }, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [status, userId, callFn]);

  // Best-effort release on unload (window close / navigating away).
  useEffect(() => {
    if (!userId) return;
    const release = () => {
      void callFn("release-session", { sessionId: sessionIdRef.current }).catch(() => {});
    };
    window.addEventListener("beforeunload", release);
    return () => window.removeEventListener("beforeunload", release);
  }, [userId, callFn]);

  const forceTakeover = useCallback(() => {
    void acquire(true);
  }, [acquire]);

  return { status, conflict, error, forceTakeover };
}
