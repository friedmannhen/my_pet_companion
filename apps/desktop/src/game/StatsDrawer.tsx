// In-overlay slide-out stats drawer — replaces the old separate frameless
// Electron BrowserWindow (formerly stats.html/StatsApp.tsx). Living in the
// same renderer as the pet means it reads `game.save` directly: no IPC
// relay or Supabase poll needed just to keep the numbers current, and no
// stock Electron window chrome to fight with. Sized to nearly the full
// work-area height on purpose — enough headroom that scrolling shouldn't
// normally be needed; `.mpc-no-scrollbar` (hud.css) hides the bar itself as
// a fallback for smaller displays without blocking the scroll gesture.
//
// Also doubles as the "kitchen": Feed and Ball no longer live on the pet's
// radial menu — you collect a food piece or the ball from here, and as of
// this pass, all account-level actions (sync/take-over/sign-out/quit) that
// used to live in a separate ribbon popover now live here too, since
// clicking the ribbon tab opens this drawer directly.
import { AnimatePresence, motion } from "framer-motion";
import { DEFAULT_PET_RULES } from "@pet/core";
import type { PetGame } from "./usePetGame";
import type { AuthState } from "../supabase/useAuth";
import type { SessionLease } from "../session/useSessionLease";
import type { RibbonSide } from "./useRibbonPrefs";
import "./hud.css";

const rules = DEFAULT_PET_RULES;
const STAGE_NAMES = ["Egg", "Baby", "Adult", "Final"];
export const DRAWER_WIDTH = 340;
const FOOD_PILE = [
  { x: -12, y: -2, rotate: -14 },
  { x: 6, y: 4, rotate: 8 },
  { x: -4, y: -8, rotate: 18 },
  { x: 14, y: -3, rotate: -6 },
];

function Bar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
        <span>{label}</span>
        <span style={{ opacity: 0.7 }}>{Math.round(value)}</span>
      </div>
      <div style={{ height: 9, borderRadius: 5, background: "rgba(255,255,255,0.1)", overflow: "hidden" }}>
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
        padding: "5px 0",
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
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  opacity: 0.55,
  marginBottom: 8,
  fontWeight: 600,
};

const chipStyle: React.CSSProperties = {
  cursor: "pointer",
  border: "none",
  borderRadius: 7,
  padding: "7px 10px",
  fontSize: 12,
  background: "rgba(255,255,255,0.1)",
  color: "#fff",
};

export function StatsDrawer({
  open,
  onClose,
  game,
  auth,
  side,
  lease,
  canFeed,
  canPlayBall,
  onCollectFood,
  onThrowBall,
  onSignOut,
  onQuit,
}: {
  open: boolean;
  onClose: () => void;
  game: PetGame;
  auth: AuthState;
  side: RibbonSide;
  lease: SessionLease;
  canFeed: boolean;
  canPlayBall: boolean;
  onCollectFood: (x: number, y: number) => void;
  onThrowBall: () => void;
  onSignOut: () => void;
  onQuit: () => void;
}) {
  const { save } = game;
  const nextThreshold =
    save.evolutionStage >= 3 ? null : rules.evolutionThresholds[(save.evolutionStage + 1) as 1 | 2 | 3];
  const ageDays = Math.max(0, Math.floor((Date.now() - new Date(save.birthDate).getTime()) / 86_400_000));

  const offscreenX = side === "right" ? DRAWER_WIDTH + 40 : -(DRAWER_WIDTH + 40);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          data-interactive
          initial={{ x: offscreenX, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: offscreenX, opacity: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 32 }}
          style={{
            position: "fixed",
            top: 12,
            bottom: 12,
            [side]: 12,
            width: DRAWER_WIDTH,
            borderRadius: 16,
            background: "rgba(21,21,27,0.96)",
            boxShadow: "0 10px 40px rgba(0,0,0,0.5)",
            border: "1px solid rgba(255,255,255,0.06)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            zIndex: 25000,
            color: "#fff",
            fontFamily: "'Segoe UI', system-ui, sans-serif",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "12px 10px 10px 18px",
              flexShrink: 0,
            }}
          >
            <strong style={{ fontSize: 13, opacity: 0.85 }}>My Pet Companion</strong>
            <button
              onClick={onClose}
              style={{
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

          <div className="mpc-no-scrollbar" style={{ flex: 1, overflowY: "auto", padding: "0 18px 18px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <h1 style={{ fontSize: 20, margin: 0 }}>{save.name}</h1>
              <span style={{ fontSize: 12, opacity: 0.6 }}>{STAGE_NAMES[save.evolutionStage]}</span>
            </div>
            <div style={{ fontSize: 11, opacity: 0.5, marginBottom: 16 }}>
              {auth.email} · {save.isAlive ? (save.isSleeping ? "sleeping" : "awake") : "deceased"}
            </div>

            {!save.isAlive && (
              <div
                style={{
                  padding: 10,
                  borderRadius: 8,
                  background: "rgba(248,113,113,0.15)",
                  color: "#fca5a5",
                  marginBottom: 14,
                  fontSize: 12,
                }}
              >
                This pet has passed away. Start a new one from the pet.
              </div>
            )}

            <section style={{ marginBottom: 16 }}>
              <h2 style={sectionTitle}>Kitchen &amp; toy box</h2>
              <div style={{ display: "flex", gap: 10 }}>
                <div
                  style={{
                    flex: 1,
                    borderRadius: 10,
                    background: "rgba(255,255,255,0.05)",
                    padding: "10px 8px",
                    textAlign: "center",
                    opacity: canFeed ? 1 : 0.4,
                  }}
                >
                  <div style={{ position: "relative", height: 40, marginBottom: 4 }}>
                    {FOOD_PILE.map((p, i) => (
                      <button
                        key={i}
                        disabled={!canFeed}
                        onClick={(e) => {
                          const r = e.currentTarget.getBoundingClientRect();
                          onCollectFood(r.left + r.width / 2, r.top + r.height / 2);
                        }}
                        title={canFeed ? "Grab a piece to throw to your pet" : "Not available right now"}
                        style={{
                          position: "absolute",
                          left: "50%",
                          top: "50%",
                          transform: `translate(-50%, -50%) translate(${p.x}px, ${p.y}px) rotate(${p.rotate}deg)`,
                          fontSize: 26,
                          border: "none",
                          background: "transparent",
                          cursor: canFeed ? "pointer" : "default",
                          padding: 0,
                          lineHeight: 1,
                        }}
                      >
                        🍖
                      </button>
                    ))}
                  </div>
                  <span style={{ fontSize: 11, opacity: 0.7 }}>Grab &amp; throw</span>
                </div>
                <div
                  style={{
                    flex: 1,
                    borderRadius: 10,
                    background: "rgba(255,255,255,0.05)",
                    padding: "10px 8px",
                    textAlign: "center",
                    opacity: canPlayBall ? 1 : 0.4,
                  }}
                >
                  <div style={{ height: 40, marginBottom: 4, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <button
                      disabled={!canPlayBall}
                      onClick={onThrowBall}
                      title={canPlayBall ? "Play fetch" : "Not available right now"}
                      style={{
                        fontSize: 28,
                        border: "none",
                        background: "transparent",
                        cursor: canPlayBall ? "pointer" : "default",
                        padding: 0,
                        lineHeight: 1,
                      }}
                    >
                      ⚾
                    </button>
                  </div>
                  <span style={{ fontSize: 11, opacity: 0.7 }}>Play fetch</span>
                </div>
              </div>
            </section>

            <section style={{ marginBottom: 16 }}>
              <h2 style={sectionTitle}>Stats</h2>
              {save.evolutionStage === 0 ? (
                <Bar label="Warmth" value={save.warmth} color="#f59e0b" />
              ) : (
                <Bar label="Hunger" value={save.hunger} color="#ef4444" />
              )}
              <Bar label="Cleanliness" value={save.cleanliness} color="#38bdf8" />
              <Bar label="Happiness" value={save.happiness} color="#a78bfa" />
            </section>

            <section style={{ marginBottom: 16 }}>
              <h2 style={sectionTitle}>Progress</h2>
              <Stat
                label="Care points"
                value={`${Math.floor(save.carePoints)}${nextThreshold !== null ? ` / ${nextThreshold}` : " (max)"}`}
              />
              <Stat label="Age" value={`${ageDays} day${ageDays === 1 ? "" : "s"}`} />
              <Stat label="Hatched" value={save.hatched ? "yes" : "no"} />
            </section>

            <section style={{ marginBottom: 16 }}>
              <h2 style={sectionTitle}>Care history</h2>
              <Stat label="🍖 Feeds" value={save.feedCount} />
              <Stat label="🧼 Washes" value={save.washCount} />
              <Stat label="🤗 Pets" value={save.petCount} />
              <Stat label="⚾ Ball throws" value={save.throwBallCount} />
              <Stat label="⚠️ Overfeeds" value={save.overfeedCount} />
            </section>

            {save.isSleeping && save.sleepKind === "manual" && save.sleepStartedAt && (
              <section style={{ marginBottom: 16 }}>
                <h2 style={sectionTitle}>Sleep</h2>
                <Stat
                  label="🛡️ Protected until"
                  value={new Date(
                    new Date(save.sleepStartedAt).getTime() + rules.sleep.protectedMaxMs,
                  ).toLocaleString()}
                />
              </section>
            )}

            <section style={{ marginBottom: 16, opacity: 0.5, fontSize: 11 }}>
              Achievements &amp; quests arrive once the full pet roster is wired up.
            </section>

            <section style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {game.syncStatus === "error" && (
                <div style={{ fontSize: 11, color: "#f87171" }}>⚠️ Sync error: {game.syncError}</div>
              )}
              {lease.status === "conflict" && (
                <button
                  style={{ ...chipStyle, background: "rgba(248,113,113,0.35)", textAlign: "left" }}
                  onClick={lease.forceTakeover}
                  title={lease.conflict ? `Active on ${lease.conflict.deviceType} — click to take over here` : "Active elsewhere"}
                >
                  ⚠️ Take over this device
                </button>
              )}
              <button style={{ ...chipStyle, textAlign: "left" }} onClick={onSignOut}>
                Sign out
              </button>
              <button style={{ ...chipStyle, textAlign: "left", opacity: 0.7 }} onClick={onQuit}>
                Quit
              </button>
            </section>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
