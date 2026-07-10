// The separate "main game window" (plan §17) — detailed stats/progress live
// here instead of cluttering the pet overlay, which only shows a compact
// radial interaction menu now (see game/RadialMenu.tsx). Read-only: the
// overlay window owns the decay tick and writes; this window receives an
// instant same-machine push on every save change (see main.ts's
// overlay:pet-state relay) and separately polls Supabase as a slow backup
// (covers the window being opened before/without a live push arriving).
//
// Frameless + transparent (see main.ts) so this reads as a HUD panel, not a
// stock Electron window — this component supplies its own rounded panel
// chrome, drag handle, and close button since there's no OS title bar.
import { useCallback, useEffect, useState } from "react";
import { DEFAULT_PET_RULES, type PetSaveData } from "@pet/core";
import { useAuth } from "../supabase/useAuth";
import { supabase } from "../supabase/client";
import { rowToSave, type PetRow } from "../supabase/petRow";

const rules = DEFAULT_PET_RULES;
const POLL_MS = 20_000;
const STAGE_NAMES = ["Egg", "Baby", "Adult", "Final"];

function Bar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
        <span>{label}</span>
        <span style={{ opacity: 0.7 }}>{Math.round(value)}</span>
      </div>
      <div
        style={{
          height: 10,
          borderRadius: 5,
          background: "rgba(255,255,255,0.1)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${Math.max(0, Math.min(100, value))}%`,
            height: "100%",
            background: color,
            transition: "width 0.3s ease",
          }}
        />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        padding: "6px 0",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        fontSize: 13,
      }}
    >
      <span style={{ opacity: 0.65 }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

const sectionTitle: React.CSSProperties = {
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  opacity: 0.55,
  marginBottom: 10,
  fontWeight: 600,
};

// Panel chrome — every screen (loading/signed-out/error/real content) is
// wrapped in this so the drag handle + close button are always present,
// matching a real HUD window rather than a bare page.
function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        margin: 10,
        height: "calc(100vh - 20px)",
        borderRadius: 16,
        background: "rgba(21,21,27,0.96)",
        boxShadow: "0 10px 40px rgba(0,0,0,0.5)",
        border: "1px solid rgba(255,255,255,0.06)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          // @ts-expect-error -- WebkitAppRegion is a real Electron/Chromium CSS extension, not in the TS DOM typings.
          WebkitAppRegion: "drag",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 8px 10px 16px",
          flexShrink: 0,
        }}
      >
        <strong style={{ fontSize: 13, opacity: 0.85 }}>My Pet Companion</strong>
        <button
          onClick={() => window.close()}
          style={{
            // @ts-expect-error -- see above
            WebkitAppRegion: "no-drag",
            cursor: "pointer",
            border: "none",
            borderRadius: 6,
            width: 26,
            height: 26,
            background: "rgba(255,255,255,0.1)",
            color: "#fff",
            fontSize: 13,
          }}
        >
          ✕
        </button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "0 20px 20px" }}>{children}</div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        padding: 24,
        textAlign: "center",
        fontSize: 14,
        opacity: 0.7,
      }}
    >
      {children}
    </div>
  );
}

export function StatsApp() {
  const auth = useAuth();
  const [save, setSave] = useState<PetSaveData | null>(null);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchRow = useCallback(async () => {
    if (!supabase || !auth.userId) return;
    const { data, error } = await supabase
      .from("pets")
      .select("*")
      .eq("user_id", auth.userId)
      .eq("pet_type", "cat")
      .maybeSingle();
    if (error) {
      setError(error.message);
      return;
    }
    setError(null);
    if (data) {
      setSave(rowToSave(data as PetRow));
      setLoadedAt(new Date());
    }
  }, [auth.userId]);

  useEffect(() => {
    if (!auth.userId) return;
    void fetchRow();
    const id = setInterval(fetchRow, POLL_MS);
    return () => clearInterval(id);
  }, [auth.userId, fetchRow]);

  // Instant path: the overlay pushes its save on every change (same
  // machine, no network) — this is what makes the HUD feel live instead of
  // lagging behind the pet by several seconds.
  useEffect(() => {
    const off = window.overlay.onPetState((incoming) => {
      setSave(incoming as PetSaveData);
      setLoadedAt(new Date());
    });
    return off;
  }, []);

  if (!auth.configured) return <Panel><Centered>Backend not configured.</Centered></Panel>;
  if (auth.loading) return <Panel><Centered>Loading…</Centered></Panel>;
  if (!auth.session) {
    return (
      <Panel>
        <Centered>
          Sign in from the pet overlay first — this window mirrors your live pet
          once you&apos;re signed in.
        </Centered>
      </Panel>
    );
  }
  if (!save) return <Panel><Centered>{error ?? "Loading your pet…"}</Centered></Panel>;

  const nextThreshold =
    save.evolutionStage >= 3 ? null : rules.evolutionThresholds[(save.evolutionStage + 1) as 1 | 2 | 3];
  const ageDays = Math.max(
    0,
    Math.floor((Date.now() - new Date(save.birthDate).getTime()) / 86_400_000),
  );

  return (
    <Panel>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>{save.name}</h1>
        <span style={{ fontSize: 13, opacity: 0.6 }}>{STAGE_NAMES[save.evolutionStage]}</span>
      </div>
      <div style={{ fontSize: 12, opacity: 0.5, marginBottom: 20 }}>
        {auth.email} · {save.isAlive ? (save.isSleeping ? "sleeping" : "awake") : "deceased"}
      </div>

      {!save.isAlive && (
        <div
          style={{
            padding: 12,
            borderRadius: 8,
            background: "rgba(248,113,113,0.15)",
            color: "#fca5a5",
            marginBottom: 16,
            fontSize: 13,
          }}
        >
          This pet has passed away. Start a new one from the pet overlay.
        </div>
      )}

      <section style={{ marginBottom: 20 }}>
        <h2 style={sectionTitle}>Stats</h2>
        {save.evolutionStage === 0 ? (
          <Bar label="Warmth" value={save.warmth} color="#f59e0b" />
        ) : (
          <Bar label="Hunger" value={save.hunger} color="#ef4444" />
        )}
        <Bar label="Cleanliness" value={save.cleanliness} color="#38bdf8" />
        <Bar label="Happiness" value={save.happiness} color="#a78bfa" />
      </section>

      <section style={{ marginBottom: 20 }}>
        <h2 style={sectionTitle}>Progress</h2>
        <Stat
          label="Care points"
          value={`${Math.floor(save.carePoints)}${nextThreshold !== null ? ` / ${nextThreshold}` : " (max)"}`}
        />
        <Stat label="Age" value={`${ageDays} day${ageDays === 1 ? "" : "s"}`} />
        <Stat label="Hatched" value={save.hatched ? "yes" : "no"} />
      </section>

      <section style={{ marginBottom: 20 }}>
        <h2 style={sectionTitle}>Care history</h2>
        <Stat label="🍖 Feeds" value={save.feedCount} />
        <Stat label="🧼 Washes" value={save.washCount} />
        <Stat label="🤗 Pets" value={save.petCount} />
        <Stat label="⚾ Ball throws" value={save.throwBallCount} />
        <Stat label="⚠️ Overfeeds" value={save.overfeedCount} />
      </section>

      {save.isSleeping && save.sleepKind === "manual" && save.sleepStartedAt && (
        <section style={{ marginBottom: 20 }}>
          <h2 style={sectionTitle}>Sleep</h2>
          <Stat
            label="🛡️ Protected until"
            value={new Date(
              new Date(save.sleepStartedAt).getTime() + rules.sleep.protectedMaxMs,
            ).toLocaleString()}
          />
        </section>
      )}

      <section style={{ marginBottom: 20, opacity: 0.5, fontSize: 12 }}>
        Achievements &amp; quests arrive once the full pet roster is wired up.
      </section>

      <div style={{ fontSize: 11, opacity: 0.4, textAlign: "right" }}>
        {error ? (
          <span style={{ color: "#f87171" }}>sync error: {error}</span>
        ) : loadedAt ? (
          `updated ${loadedAt.toLocaleTimeString()}`
        ) : (
          ""
        )}
      </div>
    </Panel>
  );
}
