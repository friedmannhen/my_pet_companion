// The separate "main game window" (plan §17) — detailed stats/progress live
// here instead of cluttering the pet overlay, which only shows a compact
// radial interaction menu now (see game/RadialMenu.tsx). Read-only: the
// overlay window owns the decay tick and writes; this window just polls the
// same `pets` row so it stays cheap and can't race the overlay's writes.
import { useCallback, useEffect, useState } from "react";
import { DEFAULT_PET_RULES, type PetSaveData } from "@pet/core";
import { useAuth } from "../supabase/useAuth";
import { supabase } from "../supabase/client";
import { rowToSave, type PetRow } from "../supabase/petRow";

const rules = DEFAULT_PET_RULES;
const POLL_MS = 5000;
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

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
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

  if (!auth.configured) return <Centered>Backend not configured.</Centered>;
  if (auth.loading) return <Centered>Loading…</Centered>;
  if (!auth.session) {
    return (
      <Centered>
        Sign in from the pet overlay first — this window mirrors your live pet
        once you&apos;re signed in.
      </Centered>
    );
  }
  if (!save) return <Centered>{error ?? "Loading your pet…"}</Centered>;

  const nextThreshold =
    save.evolutionStage >= 3 ? null : rules.evolutionThresholds[(save.evolutionStage + 1) as 1 | 2 | 3];
  const ageDays = Math.max(
    0,
    Math.floor((Date.now() - new Date(save.birthDate).getTime()) / 86_400_000),
  );

  return (
    <div style={{ padding: 20, maxWidth: 420, margin: "0 auto" }}>
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
    </div>
  );
}
