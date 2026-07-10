// The game's single side dock: a house-icon tab pinned to a screen edge,
// seamlessly fused to a slide-out drawer panel. One sliding container owns
// both — the tab is a child of the same motion.div as the drawer, so they
// move in perfect lockstep and share one background surface with no seam;
// concave corner fillets (browser-tab style) blend the tab into the drawer
// edge. Replaces the earlier separate RibbonDock + StatsDrawer pair.
//
// The tab drags VERTICALLY only (side is a Settings choice, not a drag
// outcome) and its height persists via useRibbonPrefs. Clicking the tab
// toggles the drawer.
//
// The drawer doubles as the kitchen/toy box: food pieces, the ball, and
// the sponge are grabbed/clicked HERE (no Feed/Wash/Ball on the pet's
// radial menu). Food and ball hand the live pointer event to GameView,
// which starts a framer dragControls drag on the always-mounted flying
// item — grab straight from the pile and throw.
import { useEffect, useRef, useState } from "react";
import { motion, useMotionValue, useTransform } from "framer-motion";
import { DEFAULT_PET_RULES } from "@pet/core";
import houseIcon from "../assets/widget/house.png";
import settingsIcon from "../assets/widget/widget_settings.png";
import type { PetGame } from "./usePetGame";
import type { AuthState } from "../supabase/useAuth";
import type { SessionLease } from "../session/useSessionLease";
import type { RibbonSide } from "./useRibbonPrefs";
import "./hud.css";

const rules = DEFAULT_PET_RULES;
const STAGE_NAMES = ["Egg", "Baby", "Adult", "Final"];
export const DRAWER_WIDTH = 340;
const TAB_SIZE = 46;
const FILLET = 12;
const EDGE_MARGIN = 12;
const PANEL_BG = "rgba(21,21,27,0.96)";

const FOOD_PILE_LAYOUT = [
  { x: -14, y: 2, rotate: -14 },
  { x: 8, y: 5, rotate: 8 },
  { x: -4, y: -7, rotate: 18 },
  { x: 16, y: -4, rotate: -6 },
];

const SYNC_COLOR: Record<string, string> = {
  offline: "#9ca3af",
  loading: "#fbbf24",
  synced: "#34d399",
  error: "#f87171",
};

function Bar({ icon, label, value, color, rightText }: { icon: string; label: string; value: number; color: string; rightText?: string }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
        <span>
          {icon} {label}
        </span>
        <span style={{ opacity: 0.7 }}>{rightText ?? Math.round(value)}</span>
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

const itemBoxStyle: React.CSSProperties = {
  flex: 1,
  borderRadius: 10,
  background: "rgba(255,255,255,0.05)",
  padding: "10px 8px",
  textAlign: "center",
};

function fmtEta(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export interface SideDockProps {
  side: RibbonSide;
  y: number;
  onYChange: (y: number) => void;
  onSideChange: (side: RibbonSide) => void;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  game: PetGame;
  auth: AuthState;
  lease: SessionLease;
  canFeed: boolean;
  foodReady: boolean[];
  foodEtaMs: number[];
  onGrabFood: (e: React.PointerEvent, slot: number) => void;
  ballReady: boolean;
  canPlayBall: boolean;
  onGrabBall: (e: React.PointerEvent) => void;
  canClean: boolean;
  onStartClean: () => void;
  onSignOut: () => void;
  onQuit: () => void;
}

export function SideDock({
  side,
  y,
  onYChange,
  onSideChange,
  open,
  onToggle,
  onClose,
  game,
  auth,
  lease,
  canFeed,
  foodReady,
  foodEtaMs,
  onGrabFood,
  ballReady,
  canPlayBall,
  onGrabBall,
  canClean,
  onStartClean,
  onSignOut,
  onQuit,
}: SideDockProps) {
  const { save } = game;
  const [view, setView] = useState<"home" | "settings">("home");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tabY = useMotionValue(y);
  const filletTopY = useTransform(tabY, (v) => v - FILLET);
  const filletBottomY = useTransform(tabY, (v) => v + TAB_SIZE);

  // Keep the persisted tab height on-screen even if the display shrank
  // since it was saved.
  useEffect(() => {
    const clampNow = () => {
      const h = containerRef.current?.clientHeight ?? window.innerHeight - EDGE_MARGIN * 2;
      const clamped = Math.max(0, Math.min(h - TAB_SIZE, tabY.get()));
      if (clamped !== tabY.get()) tabY.set(clamped);
    };
    clampNow();
    window.addEventListener("resize", clampNow);
    return () => window.removeEventListener("resize", clampNow);
  }, [tabY]);

  const isRight = side === "right";
  const closedX = isRight ? DRAWER_WIDTH + EDGE_MARGIN : -(DRAWER_WIDTH + EDGE_MARGIN);
  const tabLeft = isRight ? 0 : DRAWER_WIDTH;
  const drawerLeft = isRight ? TAB_SIZE : 0;
  // Junction column: the vertical strip where the tab butts the drawer.
  const filletLeft = isRight ? TAB_SIZE - FILLET : DRAWER_WIDTH;
  // Concave quarter-circle cut on the corner AWAY from the drawer.
  const filletTopBg = `radial-gradient(circle ${FILLET}px at ${isRight ? "0 0" : "100% 0"}, transparent ${FILLET - 0.5}px, ${PANEL_BG} ${FILLET}px)`;
  const filletBottomBg = `radial-gradient(circle ${FILLET}px at ${isRight ? "0 100%" : "100% 100%"}, transparent ${FILLET - 0.5}px, ${PANEL_BG} ${FILLET}px)`;

  const nextThreshold =
    save.evolutionStage >= 3 ? null : rules.evolutionThresholds[(save.evolutionStage + 1) as 1 | 2 | 3];
  const ageDays = Math.max(0, Math.floor((Date.now() - new Date(save.birthDate).getTime()) / 86_400_000));
  const nextFoodEta = foodReady.every(Boolean) ? 0 : Math.min(...foodEtaMs.filter((ms) => ms > 0));

  return (
    <motion.div
      ref={containerRef}
      initial={{ x: closedX }}
      animate={{ x: open ? 0 : closedX }}
      transition={{ type: "spring", stiffness: 300, damping: 32 }}
      style={{
        position: "fixed",
        top: EDGE_MARGIN,
        bottom: EDGE_MARGIN,
        [side]: EDGE_MARGIN,
        width: TAB_SIZE + DRAWER_WIDTH,
        pointerEvents: "none",
        zIndex: 25000,
        color: "#fff",
        fontFamily: "'Segoe UI', system-ui, sans-serif",
      }}
    >
      {/* The tab — same surface as the drawer, vertically draggable. */}
      <motion.button
        data-interactive
        drag="y"
        dragConstraints={containerRef}
        dragMomentum={false}
        dragElastic={0}
        onDragEnd={() => onYChange(tabY.get())}
        onTap={onToggle}
        title="My Pet Companion"
        style={{
          position: "absolute",
          left: tabLeft,
          top: 0,
          y: tabY,
          width: TAB_SIZE,
          height: TAB_SIZE,
          pointerEvents: "auto",
          cursor: "grab",
          border: "none",
          borderRadius: isRight ? "14px 0 0 14px" : "0 14px 14px 0",
          background: PANEL_BG,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: open ? "none" : "0 4px 16px rgba(0,0,0,0.4)",
        }}
      >
        <img src={houseIcon} alt="" width={26} height={26} draggable={false} style={{ pointerEvents: "none" }} />
        <span
          title={game.syncError ?? game.syncStatus}
          style={{
            position: "absolute",
            top: 5,
            [isRight ? "left" : "right"]: 5,
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: SYNC_COLOR[game.syncStatus] ?? "#9ca3af",
          }}
        />
      </motion.button>

      {/* Concave fillets fusing the tab into the drawer edge. */}
      <motion.div
        style={{
          position: "absolute",
          left: filletLeft,
          top: 0,
          y: filletTopY,
          width: FILLET,
          height: FILLET,
          background: filletTopBg,
          pointerEvents: "none",
        }}
      />
      <motion.div
        style={{
          position: "absolute",
          left: filletLeft,
          top: 0,
          y: filletBottomY,
          width: FILLET,
          height: FILLET,
          background: filletBottomBg,
          pointerEvents: "none",
        }}
      />

      {/* The drawer panel. */}
      <div
        data-interactive
        style={{
          position: "absolute",
          left: drawerLeft,
          top: 0,
          bottom: 0,
          width: DRAWER_WIDTH,
          pointerEvents: "auto",
          borderRadius: 16,
          [isRight ? "borderTopLeftRadius" : "borderTopRightRadius"]: 16,
          background: PANEL_BG,
          boxShadow: "0 10px 40px rgba(0,0,0,0.5)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
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
          <div style={{ display: "flex", gap: 6 }}>
            <button
              onClick={() => setView((v) => (v === "settings" ? "home" : "settings"))}
              title="Settings"
              style={{
                cursor: "pointer",
                border: "none",
                borderRadius: 6,
                width: 26,
                height: 26,
                background: view === "settings" ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.1)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <img src={settingsIcon} alt="Settings" width={16} height={16} draggable={false} />
            </button>
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
        </div>

        {view === "settings" ? (
          <div className="mpc-no-scrollbar" style={{ flex: 1, overflowY: "auto", padding: "0 18px 18px" }}>
            <section style={{ marginBottom: 18 }}>
              <h2 style={sectionTitle}>Dock position</h2>
              <div style={{ display: "flex", gap: 6 }}>
                {(["left", "right"] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => onSideChange(s)}
                    style={{
                      ...chipStyle,
                      flex: 1,
                      textAlign: "center",
                      background: side === s ? "rgba(52,211,153,0.35)" : "rgba(255,255,255,0.1)",
                    }}
                  >
                    {s === "left" ? "⬅️ Left edge" : "Right edge ➡️"}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 11, opacity: 0.5, marginTop: 6 }}>
                Drag the house tab up/down to set its height.
              </div>
            </section>

            <section style={{ marginBottom: 18 }}>
              <h2 style={sectionTitle}>Account</h2>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {game.syncStatus === "error" && (
                  <div style={{ fontSize: 11, color: "#f87171" }}>⚠️ Sync error: {game.syncError}</div>
                )}
                {lease.status === "conflict" && (
                  <button
                    style={{ ...chipStyle, background: "rgba(248,113,113,0.35)", textAlign: "left" }}
                    onClick={lease.forceTakeover}
                    title={
                      lease.conflict
                        ? `Active on ${lease.conflict.deviceType} — click to take over here`
                        : "Active elsewhere"
                    }
                  >
                    ⚠️ Take over this device
                  </button>
                )}
                <div style={{ fontSize: 11, opacity: 0.5 }}>{auth.email}</div>
                <button style={{ ...chipStyle, textAlign: "left" }} onClick={onSignOut}>
                  Sign out
                </button>
                <button style={{ ...chipStyle, textAlign: "left", opacity: 0.7 }} onClick={onQuit}>
                  Quit
                </button>
              </div>
            </section>

            <section style={{ opacity: 0.45, fontSize: 11 }}>
              Sound, pet naming and more options land here later.
            </section>
          </div>
        ) : (
          <div className="mpc-no-scrollbar" style={{ flex: 1, overflowY: "auto", padding: "0 18px 18px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <h1 style={{ fontSize: 20, margin: 0 }}>{save.name}</h1>
              <span style={{ fontSize: 12, opacity: 0.6 }}>{STAGE_NAMES[save.evolutionStage]}</span>
            </div>
            <div style={{ fontSize: 11, opacity: 0.5, marginBottom: 16 }}>
              {save.isAlive ? (save.isSleeping ? "sleeping 💤" : "awake") : "deceased"}
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
              <div style={{ display: "flex", gap: 8 }}>
                {/* Food pile — grab a piece straight off the pile and throw it. */}
                <div style={{ ...itemBoxStyle, opacity: canFeed ? 1 : 0.45 }}>
                  <div style={{ position: "relative", height: 42, marginBottom: 4 }}>
                    {FOOD_PILE_LAYOUT.map((p, i) => (
                      <span
                        key={i}
                        onPointerDown={canFeed && foodReady[i] ? (e) => onGrabFood(e, i) : undefined}
                        title={
                          !canFeed
                            ? "Not available right now"
                            : foodReady[i]
                              ? "Grab and throw to your pet"
                              : `Regrows in ${fmtEta(foodEtaMs[i] ?? 0)}`
                        }
                        style={{
                          position: "absolute",
                          left: "50%",
                          top: "50%",
                          transform: `translate(-50%, -50%) translate(${p.x}px, ${p.y}px) rotate(${p.rotate}deg)`,
                          fontSize: 26,
                          lineHeight: 1,
                          userSelect: "none",
                          cursor: canFeed && foodReady[i] ? "grab" : "default",
                          opacity: foodReady[i] ? 1 : 0.15,
                          filter: foodReady[i] ? undefined : "grayscale(1)",
                        }}
                      >
                        🍖
                      </span>
                    ))}
                  </div>
                  <span style={{ fontSize: 11, opacity: 0.7 }}>
                    {nextFoodEta > 0 ? `next 🍖 in ${fmtEta(nextFoodEta)}` : "Grab & throw"}
                  </span>
                </div>

                {/* The ball — grab it and throw; comes back when the pet's done. */}
                <div style={{ ...itemBoxStyle, opacity: canPlayBall ? 1 : 0.45 }}>
                  <div style={{ height: 42, marginBottom: 4, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <span
                      onPointerDown={canPlayBall && ballReady ? onGrabBall : undefined}
                      title={
                        !canPlayBall
                          ? "Not available right now"
                          : ballReady
                            ? "Grab and throw — the pet will fetch it"
                            : "The pet is playing with it"
                      }
                      style={{
                        fontSize: 28,
                        lineHeight: 1,
                        userSelect: "none",
                        cursor: canPlayBall && ballReady ? "grab" : "default",
                        opacity: ballReady ? 1 : 0.15,
                        filter: ballReady ? undefined : "grayscale(1)",
                      }}
                    >
                      ⚾
                    </span>
                  </div>
                  <span style={{ fontSize: 11, opacity: 0.7 }}>{ballReady ? "Grab & throw" : "Out playing…"}</span>
                </div>

                {/* The sponge — click to enter scrub mode. */}
                <div style={{ ...itemBoxStyle, opacity: canClean ? 1 : 0.45 }}>
                  <div style={{ height: 42, marginBottom: 4, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <span
                      onClick={canClean ? onStartClean : undefined}
                      title={
                        canClean
                          ? "Grab the sponge and scrub your pet"
                          : save.cleanliness >= 100
                            ? "Already squeaky clean"
                            : "Not available right now"
                      }
                      style={{
                        fontSize: 28,
                        lineHeight: 1,
                        userSelect: "none",
                        cursor: canClean ? "pointer" : "default",
                      }}
                    >
                      🧽
                    </span>
                  </div>
                  <span style={{ fontSize: 11, opacity: 0.7 }}>Scrub clean</span>
                </div>
              </div>
            </section>

            <section style={{ marginBottom: 16 }}>
              <h2 style={sectionTitle}>Stats</h2>
              {save.evolutionStage === 0 ? (
                <Bar icon="🔥" label="Warmth" value={save.warmth} color="#f59e0b" />
              ) : (
                <Bar icon="🍖" label="Hunger" value={save.hunger} color="#ef4444" />
              )}
              <Bar icon="🧼" label="Cleanliness" value={save.cleanliness} color="#38bdf8" />
              <Bar icon="❤️" label="Happiness" value={save.happiness} color="#a78bfa" />
              <Bar
                icon="⭐"
                label="Care points"
                value={game.evolutionProgress * 100}
                color="linear-gradient(90deg, #b45309, #f59e0b, #fde68a)"
                rightText={`${Math.floor(save.carePoints)}${nextThreshold !== null ? ` / ${nextThreshold}` : " (max)"}`}
              />
            </section>

            <section style={{ marginBottom: 16 }}>
              <h2 style={sectionTitle}>Progress</h2>
              <Stat label="Age" value={`${ageDays} day${ageDays === 1 ? "" : "s"}`} />
              <Stat label="Stage" value={STAGE_NAMES[save.evolutionStage] ?? "?"} />
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

            <section style={{ marginBottom: 8, opacity: 0.5, fontSize: 11 }}>
              Achievements &amp; quests arrive once the full pet roster is wired up.
            </section>
          </div>
        )}
      </div>
    </motion.div>
  );
}
