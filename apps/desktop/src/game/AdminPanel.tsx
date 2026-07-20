// Dev-only admin panel (plan §11) — replaces the ERP hub's env-var-driven
// preset system with one-click buttons. This module is only ever rendered
// behind `import.meta.env.DEV`, so production builds dead-code-eliminate it.
import { useState } from "react";
import { DEFAULT_PET_RULES, freshPetSave, type PetSaveData } from "@pet/core";
import type { PetGame } from "./usePetGame";
import type { Consumables } from "./useConsumables";
import { Tooltip } from "./Tooltip";

const T = DEFAULT_PET_RULES.evolutionThresholds;

type Preset = { label: string; build: () => PetSaveData };

const PRESETS: Preset[] = [
  { label: "🥚 Fresh egg", build: () => freshPetSave({ petType: "cat" }) },
  {
    label: "✨ Ready to hatch",
    build: () =>
      freshPetSave({ petType: "cat", carePoints: T[1], warmth: 90, cleanliness: 60, happiness: 60 }),
  },
  {
    label: "🐱 Baby",
    build: () =>
      freshPetSave({
        petType: "cat",
        evolutionStage: 1,
        hatched: true,
        carePoints: T[1] + 10,
        carePointsFloor: T[1],
        hunger: 80,
        cleanliness: 80,
        happiness: 80,
      }),
  },
  {
    label: "🐈 Adult",
    build: () =>
      freshPetSave({
        petType: "cat",
        evolutionStage: 2,
        hatched: true,
        carePoints: T[2] + 10,
        carePointsFloor: T[2],
        hunger: 80,
        cleanliness: 80,
        happiness: 80,
      }),
  },
  {
    label: "🐈‍⬛ Final",
    build: () =>
      freshPetSave({
        petType: "cat",
        evolutionStage: 3,
        hatched: true,
        carePoints: T[3],
        carePointsFloor: T[3],
        hunger: 80,
        cleanliness: 80,
        happiness: 80,
      }),
  },
  {
    label: "🍖 Starving",
    build: () =>
      freshPetSave({
        petType: "cat",
        evolutionStage: 2,
        hatched: true,
        carePoints: T[2] + 200,
        carePointsFloor: T[2],
        hunger: 8,
        cleanliness: 40,
        happiness: 40,
      }),
  },
  {
    label: "🧼 Filthy & sad",
    build: () =>
      freshPetSave({
        petType: "cat",
        evolutionStage: 2,
        hatched: true,
        carePoints: T[2] + 200,
        carePointsFloor: T[2],
        hunger: 60,
        cleanliness: 5,
        happiness: 5,
      }),
  },
  {
    // Hard death was removed (Phase C, plan-deathDecayMinigameBalance.md) —
    // hunger clamps at 0 and stays interactive instead of ending the save,
    // so this preset previews that distressed state directly (isAlive:
    // false is no longer reachable from normal play; the one remaining
    // isAlive:false path is a legacy pre-Phase-C save, auto-revived on load
    // by usePetGame.ts's reviveIfDead — nothing left to preview there).
    label: "😢 Distressed (hunger 0)",
    build: () =>
      freshPetSave({
        petType: "cat",
        evolutionStage: 2,
        hatched: true,
        carePoints: T[2] + 100,
        carePointsFloor: T[2],
        hunger: 0,
      }),
  },
];

const btn: React.CSSProperties = {
  cursor: "pointer",
  border: "none",
  borderRadius: 6,
  padding: "4px 8px",
  fontSize: 11,
  background: "rgba(255,255,255,0.12)",
  color: "#fff",
  textAlign: "left",
};

const dangerBtn: React.CSSProperties = {
  ...btn,
  background: "rgba(248,113,113,0.25)",
};

export function AdminPanel({ game, consumables }: { game: PetGame; consumables: Consumables }) {
  const [open, setOpen] = useState(false);
  const { save } = game;

  const fullReset = () => {
    if (!confirm("Full reset: pet, quests, achievements, hall-of-fame claims, and the food/ball pile. Continue?")) {
      return;
    }
    game.restart();
    void game.achievements.resetAll();
    void game.debugResetHallOfFame();
    consumables.resetAll();
  };

  return (
    <div
      data-interactive
      style={{
        position: "fixed",
        bottom: 12,
        left: 12,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        fontFamily: "'Segoe UI', system-ui, sans-serif",
      }}
    >
      {open && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            padding: 10,
            borderRadius: 10,
            width: 210,
            background: "rgba(60,20,20,0.95)",
            color: "#fff",
            boxShadow: "0 4px 18px rgba(0,0,0,0.5)",
          }}
        >
          <strong style={{ fontSize: 12, color: "#fca5a5" }}>DEV ADMIN</strong>

          <span style={{ fontSize: 10, opacity: 0.7 }}>Presets</span>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
            {PRESETS.map((p) => (
              <button key={p.label} style={btn} onClick={() => game.debugLoadPreset(p.build())}>
                {p.label}
              </button>
            ))}
          </div>

          <span style={{ fontSize: 10, opacity: 0.7, marginTop: 4 }}>Care points</span>
          <div style={{ display: "flex", gap: 4 }}>
            {[10, 100, 500].map((n) => (
              <button
                key={n}
                style={btn}
                onClick={() => game.debugApply({ carePoints: save.carePoints + n })}
              >
                +{n}
              </button>
            ))}
          </div>

          <span style={{ fontSize: 10, opacity: 0.7, marginTop: 4 }}>Stats → value</span>
          <div style={{ display: "flex", gap: 4 }}>
            {[5, 50, 100].map((v) => (
              <button
                key={v}
                style={btn}
                onClick={() =>
                  game.debugApply({ hunger: v, warmth: v, cleanliness: v, happiness: v })
                }
              >
                all={v}
              </button>
            ))}
          </div>

          <span style={{ fontSize: 10, opacity: 0.7, marginTop: 4 }}>
            Time jump (simulate app closed — also clears feed/wash/pet
            cooldowns &amp; quest gaps)
          </span>
          <div style={{ display: "flex", gap: 4 }}>
            {[1, 12, 80].map((h) => (
              <button key={h} style={btn} onClick={() => game.debugTimeJump(h)}>
                +{h}h
              </button>
            ))}
          </div>

          <span style={{ fontSize: 10, opacity: 0.7, marginTop: 4 }}>Cooldowns &amp; items</span>
          <div style={{ display: "flex", gap: 4 }}>
            <button style={btn} onClick={game.debugClearCooldowns}>
              ⏱️ Clear cooldowns
            </button>
            <button style={btn} onClick={consumables.resetAll}>
              🍖⚾ Refill pile
            </button>
          </div>

          <span style={{ fontSize: 10, opacity: 0.7, marginTop: 4 }}>Reset</span>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
            <button style={btn} onClick={game.debugResetQuests}>
              📜 Quests only
            </button>
            <button style={btn} onClick={() => void game.achievements.resetAll()}>
              🏆 Achievements only
            </button>
            <button style={btn} onClick={() => void game.debugResetHallOfFame()}>
              🏛️ My hall-of-fame claims
            </button>
            <button style={dangerBtn} onClick={fullReset}>
              💥 Full reset
            </button>
          </div>
        </div>
      )}
      <Tooltip label="Dev admin panel">
        <button
          style={{ ...btn, width: 34, height: 30, textAlign: "center", opacity: 0.8 }}
          onClick={() => setOpen((o) => !o)}
        >
          🛠️
        </button>
      </Tooltip>
    </div>
  );
}
