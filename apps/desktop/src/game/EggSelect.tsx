// First-launch starter-egg picker. Only the cat has real art today (the
// MVP roster's single shipped creature) — the 3 options are cosmetic tints
// of the same egg art, all resolving to petType "cat" under the hood, so
// this screen ships now instead of waiting on new art for other PetTypes.
// Swap in real per-type egg art here once more creatures are added.
import eggIdle from "../assets/pets/black_cat/egg/1.png";

const EGG_OPTIONS = [
  { key: "shadow", label: "Shadow Egg", filter: "none" },
  { key: "ember", label: "Ember Egg", filter: "hue-rotate(320deg) saturate(1.6)" },
  { key: "frost", label: "Frost Egg", filter: "hue-rotate(180deg) saturate(1.3)" },
] as const;

export function EggSelect({ onChoose }: { onChoose: () => void }) {
  return (
    <div
      data-interactive
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(10,10,14,0.6)",
        zIndex: 30000,
        fontFamily: "'Segoe UI', system-ui, sans-serif",
      }}
    >
      <div
        style={{
          width: 360,
          borderRadius: 16,
          background: "rgba(21,21,27,0.97)",
          color: "#fff",
          padding: 20,
          boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
        }}
      >
        <strong style={{ fontSize: 15 }}>Choose your egg</strong>
        <p style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
          Pick a starter egg to hatch and raise. More creatures are coming soon.
        </p>
        <div style={{ display: "flex", gap: 12, marginTop: 16, justifyContent: "center" }}>
          {EGG_OPTIONS.map((egg) => (
            <button
              key={egg.key}
              onClick={onChoose}
              style={{
                cursor: "pointer",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 12,
                background: "rgba(255,255,255,0.05)",
                color: "#fff",
                padding: "12px 10px",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 8,
                width: 100,
              }}
            >
              <img
                src={eggIdle}
                width={56}
                height={56}
                draggable={false}
                alt={egg.label}
                style={{ filter: egg.filter }}
              />
              <span style={{ fontSize: 11, fontWeight: 600 }}>{egg.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
