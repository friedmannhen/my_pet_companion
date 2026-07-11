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
import {
  DAILY_QUEST_CODES,
  DEFAULT_PET_RULES,
  GUARDIAN_MINUTES_PER_DAY,
  PET_ACHIEVEMENT_CODES,
  PET_ACHIEVEMENT_DEFINITIONS,
  PET_QUEST_DEFINITIONS,
  WEEKLY_QUEST_CODES,
  WEEKLY_QUEST_TARGET_DAYS,
  countQualifiedDays,
  describeReward,
  type PetQuestCode,
  type PetSaveData,
  type QuestClaimState,
} from "@pet/core";
import houseIcon from "../assets/widget/house.png";
import settingsIcon from "../assets/widget/widget_settings.png";
import type { PetGame } from "./usePetGame";
import type { AuthState } from "../supabase/useAuth";
import type { SessionLease } from "../session/useSessionLease";
import type { RibbonSide } from "./useRibbonPrefs";
import { useLeaderboard } from "./useLeaderboard";
import type { GroupInfo, UseGroups } from "./useGroups";
import "./hud.css";

const rules = DEFAULT_PET_RULES;
const STAGE_NAMES = ["Egg", "Baby", "Adult", "Final"];
const STAGE_EMOJI = ["🥚", "🐣", "🐈", "😼"];
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

function guardianDaysText(map: Record<string, number>): string {
  return `${countQualifiedDays(map, GUARDIAN_MINUTES_PER_DAY)}/${WEEKLY_QUEST_TARGET_DAYS} days (${GUARDIAN_MINUTES_PER_DAY} good min each)`;
}

function questProgressText(save: PetSaveData, code: PetQuestCode): string {
  const q = save.quests;
  if (!q) return "";
  switch (code) {
    case "balancedCare":
      return `🍖 ${q.daily.feedQualifiedCount}/3 · 🧼 ${q.daily.washQualifiedCount}/3 · 🤗 ${q.daily.petQualifiedCount}/3`;
    case "focusSession":
      return `${Math.floor(q.daily.focusEligibleMinutes)}/${rules.quest.focusMinutesRequired} focused minutes`;
    case "cleanRun":
      return q.daily.hadOverfeedToday
        ? "Failed today — there was an overfeed"
        : q.daily.cleanRunWindowClosed
          ? "Today's window closed"
          : "No overfeeds so far — keep it up";
    case "noOverfeedWeek":
      return q.weekly.hadOverfeedWeek
        ? "Failed this week — there was an overfeed"
        : `${Object.keys(q.weekly.feedDaysByDayKey).length}/${WEEKLY_QUEST_TARGET_DAYS} feed days`;
    case "dailyPlayWeek":
      return `${countQualifiedDays(q.weekly.playCountByDayKey, 2)}/${WEEKLY_QUEST_TARGET_DAYS} play days (2+ throws each)`;
    case "hungerGuardian":
      return guardianDaysText(q.weekly.hungerOkMinutesByDayKey);
    case "cleanlinessGuardian":
      return guardianDaysText(q.weekly.cleanlinessOkMinutesByDayKey);
    case "happinessGuardian":
      return guardianDaysText(q.weekly.happinessOkMinutesByDayKey);
  }
}

function QuestCard({
  code,
  state,
  progressText,
  onClaim,
}: {
  code: PetQuestCode;
  state: QuestClaimState | undefined;
  progressText: string;
  onClaim: () => void;
}) {
  const def = PET_QUEST_DEFINITIONS[code];
  const status = state?.status ?? "in_progress";
  return (
    <div
      style={{
        borderRadius: 10,
        background: status === "claimable" ? "rgba(52,211,153,0.12)" : "rgba(255,255,255,0.05)",
        border: status === "claimable" ? "1px solid rgba(52,211,153,0.4)" : "1px solid transparent",
        padding: "8px 10px",
        marginBottom: 8,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <strong style={{ fontSize: 12 }}>{def.title}</strong>
        {status === "claimable" ? (
          <button
            onClick={onClaim}
            style={{
              cursor: "pointer",
              border: "none",
              borderRadius: 7,
              padding: "4px 10px",
              fontSize: 11,
              fontWeight: 700,
              background: "rgba(52,211,153,0.85)",
              color: "#06281c",
              flexShrink: 0,
            }}
          >
            Claim +{def.rewardPoints} ⭐
          </button>
        ) : status === "claimed" ? (
          <span style={{ fontSize: 11, color: "#34d399", flexShrink: 0 }}>✓ +{state?.awardedPoints ?? def.rewardPoints} ⭐</span>
        ) : (
          <span style={{ fontSize: 10, opacity: 0.55, flexShrink: 0 }}>+{def.rewardPoints} ⭐</span>
        )}
      </div>
      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>{def.description}</div>
      {status === "in_progress" && (
        <div style={{ fontSize: 11, marginTop: 4, color: "#93c5fd" }}>{progressText}</div>
      )}
    </div>
  );
}

/** Small red count badge pinned to a nav button / the dock tab. */
function Badge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      style={{
        position: "absolute",
        top: -4,
        right: -4,
        minWidth: 14,
        height: 14,
        borderRadius: 999,
        background: "#ef4444",
        color: "#fff",
        fontSize: 9,
        fontWeight: 800,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "0 3px",
        pointerEvents: "none",
      }}
    >
      {count}
    </span>
  );
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
  soundEnabled: boolean;
  onToggleSound: () => void;
  onRename: (name: string) => void;
  onSignOut: () => void;
  onQuit: () => void;
  appVersion: string;
  updateState: "idle" | "downloading" | "ready";
  onInstallUpdate: () => void;
  groupsApi: UseGroups;
  /** Group id of the room we're currently in (null = offline). */
  activeRoomGroupId: string | null;
  /** False while the pet is still an egg — online play is locked. */
  canGoOnline: boolean;
  onEnterRoom: (group: GroupInfo) => void;
  onLeaveRoom: () => void;
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
  soundEnabled,
  onToggleSound,
  onRename,
  onSignOut,
  onQuit,
  appVersion,
  updateState,
  onInstallUpdate,
  groupsApi,
  activeRoomGroupId,
  canGoOnline,
  onEnterRoom,
  onLeaveRoom,
}: SideDockProps) {
  const { save } = game;
  const [view, setView] = useState<"home" | "quests" | "awards" | "ranks" | "groups" | "settings">("home");
  const [groupNameDraft, setGroupNameDraft] = useState("");
  const [joinCodeDraft, setJoinCodeDraft] = useState("");
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState(save.name);
  const [renameSaved, setRenameSaved] = useState(false);
  const [displayNameDraft, setDisplayNameDraft] = useState(auth.displayName ?? "");
  const [displayNameSaved, setDisplayNameSaved] = useState(false);

  const saveDisplayName = () => {
    const trimmed = displayNameDraft.trim();
    if (!trimmed) return;
    void auth.updateDisplayName(trimmed).then(() => setDisplayNameSaved(true));
  };

  // The rename/group text inputs need real OS keyboard focus (the overlay
  // window is non-focusable by default — see main.ts). Granted only while a
  // typing-capable view is actually open, same bounded-interaction pattern
  // as wash-scrub and the auth card.
  const settingsActive = open && (view === "settings" || view === "groups");
  useEffect(() => {
    if (!settingsActive) return;
    window.overlay.setFocusable(true);
    return () => window.overlay.setFocusable(false);
  }, [settingsActive]);
  useEffect(() => {
    if (settingsActive) {
      setNameDraft(save.name);
      setDisplayNameDraft(auth.displayName ?? "");
      setRenameSaved(false);
      setDisplayNameSaved(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsActive]);
  const leaderboard = useLeaderboard(auth.userId, open && view === "ranks");
  const claimableTotal = game.claimableQuestCount + game.achievements.claimableCount;
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
        {!open && claimableTotal > 0 && (
          <span
            title={`${claimableTotal} reward${claimableTotal === 1 ? "" : "s"} ready to claim`}
            style={{
              position: "absolute",
              bottom: 3,
              [isRight ? "left" : "right"]: 3,
              minWidth: 14,
              height: 14,
              borderRadius: 999,
              background: "#ef4444",
              color: "#fff",
              fontSize: 9,
              fontWeight: 800,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "0 3px",
            }}
          >
            {claimableTotal}
          </span>
        )}
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
          <div style={{ display: "flex", gap: 5 }}>
            {(
              [
                { key: "home", icon: "🏠", label: "Home", badge: 0 },
                { key: "quests", icon: "📜", label: "Quests", badge: game.claimableQuestCount },
                { key: "awards", icon: "🏆", label: "Achievements", badge: game.achievements.claimableCount },
                { key: "ranks", icon: "🌍", label: "Leaderboard & hall of fame", badge: 0 },
                { key: "groups", icon: "👥", label: "Groups & online rooms", badge: 0 },
              ] as const
            ).map((nav) => (
              <button
                key={nav.key}
                onClick={() => setView(nav.key)}
                title={nav.label}
                style={{
                  position: "relative",
                  cursor: "pointer",
                  border: "none",
                  borderRadius: 6,
                  width: 26,
                  height: 26,
                  fontSize: 13,
                  background: view === nav.key ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.1)",
                }}
              >
                {nav.icon}
                <Badge count={nav.badge} />
              </button>
            ))}
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
              <h2 style={sectionTitle}>Game</h2>
              <button style={{ ...chipStyle, width: "100%", textAlign: "left" }} onClick={onToggleSound}>
                {soundEnabled ? "🔊 Sounds: on" : "🔇 Sounds: off"}
              </button>
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <input
                  value={nameDraft}
                  onChange={(e) => {
                    setNameDraft(e.target.value);
                    setRenameSaved(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      onRename(nameDraft);
                      setRenameSaved(true);
                    }
                  }}
                  maxLength={24}
                  placeholder="Pet name"
                  style={{
                    flex: 1,
                    border: "1px solid rgba(255,255,255,0.15)",
                    borderRadius: 7,
                    padding: "6px 8px",
                    fontSize: 12,
                    background: "rgba(255,255,255,0.06)",
                    color: "#fff",
                    outline: "none",
                  }}
                />
                <button
                  style={{ ...chipStyle, opacity: nameDraft.trim() && nameDraft.trim() !== save.name ? 1 : 0.5 }}
                  onClick={() => {
                    onRename(nameDraft);
                    setRenameSaved(true);
                  }}
                  disabled={!nameDraft.trim() || nameDraft.trim() === save.name}
                >
                  Rename
                </button>
              </div>
              {renameSaved && nameDraft.trim() === save.name && (
                <div style={{ fontSize: 11, color: "#34d399", marginTop: 4 }}>✓ Renamed to {save.name}!</div>
              )}
            </section>

            <section style={{ marginBottom: 18 }}>
              <h2 style={sectionTitle}>Profile</h2>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  value={displayNameDraft}
                  onChange={(e) => {
                    setDisplayNameDraft(e.target.value);
                    setDisplayNameSaved(false);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && saveDisplayName()}
                  maxLength={40}
                  placeholder="Display name (shown on leaderboards)"
                  style={{
                    flex: 1,
                    border: "1px solid rgba(255,255,255,0.15)",
                    borderRadius: 7,
                    padding: "6px 8px",
                    fontSize: 12,
                    background: "rgba(255,255,255,0.06)",
                    color: "#fff",
                    outline: "none",
                  }}
                />
                <button
                  style={{ ...chipStyle, opacity: displayNameDraft.trim() ? 1 : 0.5 }}
                  onClick={saveDisplayName}
                  disabled={!displayNameDraft.trim()}
                >
                  Save
                </button>
              </div>
              {displayNameSaved && (
                <div style={{ fontSize: 11, color: "#34d399", marginTop: 4 }}>✓ Saved!</div>
              )}
              {!auth.displayName && !displayNameSaved && (
                <div style={{ fontSize: 10, opacity: 0.5, marginTop: 4 }}>
                  Currently showing your email prefix instead.
                </div>
              )}
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
                {lease.status === "kicked" && (
                  <button
                    style={{ ...chipStyle, background: "rgba(127,29,29,0.6)", textAlign: "left" }}
                    onClick={lease.forceTakeover}
                    title="Your account signed in elsewhere and this device was disconnected. Click to reconnect here — it will disconnect that other device instead."
                  >
                    🔒 Disconnected — click to reconnect here
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
              More options land here as the game grows.
            </section>
          </div>
        ) : view === "quests" ? (
          <div className="mpc-no-scrollbar" style={{ flex: 1, overflowY: "auto", padding: "0 18px 18px" }}>
            <section style={{ marginBottom: 14 }}>
              <h2 style={sectionTitle}>Daily quests</h2>
              {DAILY_QUEST_CODES.map((code) => (
                <QuestCard
                  key={code}
                  code={code}
                  state={save.quests?.daily.quests[code]}
                  progressText={questProgressText(save, code)}
                  onClaim={() => game.claimQuest(code)}
                />
              ))}
            </section>
            <section style={{ marginBottom: 10 }}>
              <h2 style={sectionTitle}>Weekly quests</h2>
              {WEEKLY_QUEST_CODES.map((code) => (
                <QuestCard
                  key={code}
                  code={code}
                  state={save.quests?.weekly.quests[code]}
                  progressText={questProgressText(save, code)}
                  onClaim={() => game.claimQuest(code)}
                />
              ))}
            </section>
            <div style={{ fontSize: 10, opacity: 0.45 }}>
              Dailies reset each day (unclaimed rewards are lost); weeklies need any{" "}
              {WEEKLY_QUEST_TARGET_DAYS} good days out of the week.
            </div>
          </div>
        ) : view === "awards" ? (
          <div className="mpc-no-scrollbar" style={{ flex: 1, overflowY: "auto", padding: "0 18px 18px" }}>
            <section>
              <h2 style={sectionTitle}>Achievements</h2>
              {PET_ACHIEVEMENT_CODES.map((code) => {
                const def = PET_ACHIEVEMENT_DEFINITIONS[code];
                const entry = game.achievements.state.earned[code];
                const progress = Math.min(def.target, game.achievements.progress(code));
                const claimable = entry?.status === "claimable";
                const claimed = entry?.status === "claimed";
                return (
                  <div
                    key={code}
                    style={{
                      borderRadius: 10,
                      background: claimable ? "rgba(251,191,36,0.12)" : "rgba(255,255,255,0.05)",
                      border: claimable ? "1px solid rgba(251,191,36,0.45)" : "1px solid transparent",
                      padding: "8px 10px",
                      marginBottom: 8,
                      opacity: claimed ? 0.75 : 1,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                      <strong style={{ fontSize: 12 }}>
                        {def.icon} {def.title}
                      </strong>
                      {claimable ? (
                        <button
                          onClick={() => game.achievements.claim(code)}
                          style={{
                            cursor: "pointer",
                            border: "none",
                            borderRadius: 7,
                            padding: "4px 10px",
                            fontSize: 11,
                            fontWeight: 700,
                            background: "rgba(251,191,36,0.9)",
                            color: "#3b2503",
                            flexShrink: 0,
                          }}
                        >
                          Claim
                        </button>
                      ) : claimed ? (
                        <span style={{ fontSize: 11, color: "#fbbf24", flexShrink: 0 }}>✓ claimed</span>
                      ) : (
                        <span style={{ fontSize: 10, opacity: 0.55, flexShrink: 0 }}>
                          {Math.floor(progress)}/{def.target}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>{def.description}</div>
                    <div style={{ fontSize: 10, marginTop: 3, color: "#fbbf24", opacity: claimed ? 1 : 0.7 }}>
                      {describeReward(def.reward)}
                    </div>
                    {!claimed && !claimable && (
                      <div
                        style={{
                          marginTop: 5,
                          height: 5,
                          borderRadius: 999,
                          background: "rgba(255,255,255,0.08)",
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            width: `${Math.min(100, (progress / def.target) * 100)}%`,
                            height: "100%",
                            background: "rgba(251,191,36,0.6)",
                          }}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </section>
          </div>
        ) : view === "groups" ? (
          <div className="mpc-no-scrollbar" style={{ flex: 1, overflowY: "auto", padding: "0 18px 18px" }}>
            {!canGoOnline && (
              <div
                style={{
                  padding: 10,
                  borderRadius: 8,
                  background: "rgba(251,191,36,0.15)",
                  color: "#fde68a",
                  marginBottom: 14,
                  fontSize: 12,
                }}
              >
                🥚 Only hatched pets can go online — warm your egg first!
              </div>
            )}

            <section style={{ marginBottom: 16 }}>
              <h2 style={sectionTitle}>My groups</h2>
              {groupsApi.error && (
                <div style={{ fontSize: 11, color: "#f87171", marginBottom: 8 }}>⚠️ {groupsApi.error}</div>
              )}
              {groupsApi.groups.map((g) => {
                const inThisRoom = activeRoomGroupId === g.id;
                return (
                  <div
                    key={g.id}
                    style={{
                      borderRadius: 10,
                      background: inThisRoom ? "rgba(52,211,153,0.12)" : "rgba(255,255,255,0.05)",
                      border: inThisRoom ? "1px solid rgba(52,211,153,0.4)" : "1px solid transparent",
                      padding: "8px 10px",
                      marginBottom: 8,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                      <strong style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {g.groupType === "global" ? "🌍" : "👥"} {g.name}
                      </strong>
                      {inThisRoom ? (
                        <button style={{ ...chipStyle, background: "rgba(248,113,113,0.35)", flexShrink: 0 }} onClick={onLeaveRoom}>
                          Leave room
                        </button>
                      ) : (
                        <button
                          style={{ ...chipStyle, background: "rgba(52,211,153,0.35)", flexShrink: 0, opacity: canGoOnline ? 1 : 0.4 }}
                          disabled={!canGoOnline}
                          title={canGoOnline ? "Go online in this group's room" : "Hatch your egg first"}
                          onClick={() => onEnterRoom(g)}
                        >
                          🌐 Enter room
                        </button>
                      )}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, fontSize: 10, opacity: 0.75 }}>
                      {g.inviteCode && g.groupType !== "global" && (
                        <>
                          <span>
                            Invite code: <strong style={{ letterSpacing: 1 }}>{g.inviteCode}</strong>
                          </span>
                          <button
                            style={{ ...chipStyle, padding: "1px 6px", fontSize: 10 }}
                            onClick={() => {
                              void navigator.clipboard.writeText(g.inviteCode!);
                              setCopiedCode(g.id);
                              setTimeout(() => setCopiedCode((c) => (c === g.id ? null : c)), 1500);
                            }}
                          >
                            {copiedCode === g.id ? "✓ copied" : "copy"}
                          </button>
                        </>
                      )}
                      {g.groupType === "global" && <span>Everyone is here automatically.</span>}
                      <span style={{ marginLeft: "auto", opacity: 0.6 }}>{g.role}</span>
                    </div>
                  </div>
                );
              })}
              {groupsApi.groups.length === 0 && !groupsApi.loading && (
                <div style={{ fontSize: 12, opacity: 0.6 }}>No groups yet — create one below.</div>
              )}
            </section>

            <section style={{ marginBottom: 16 }}>
              <h2 style={sectionTitle}>Create a group</h2>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  value={groupNameDraft}
                  onChange={(e) => setGroupNameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && groupNameDraft.trim().length >= 2) {
                      void groupsApi.create(groupNameDraft).then(() => setGroupNameDraft(""));
                    }
                  }}
                  maxLength={40}
                  placeholder="Group name"
                  style={{
                    flex: 1,
                    border: "1px solid rgba(255,255,255,0.15)",
                    borderRadius: 7,
                    padding: "6px 8px",
                    fontSize: 12,
                    background: "rgba(255,255,255,0.06)",
                    color: "#fff",
                    outline: "none",
                  }}
                />
                <button
                  style={{ ...chipStyle, opacity: groupNameDraft.trim().length >= 2 ? 1 : 0.5 }}
                  disabled={groupNameDraft.trim().length < 2}
                  onClick={() => void groupsApi.create(groupNameDraft).then(() => setGroupNameDraft(""))}
                >
                  Create
                </button>
              </div>
              <div style={{ fontSize: 10, opacity: 0.5, marginTop: 4 }}>
                You get an invite code to share with friends.
              </div>
            </section>

            <section style={{ marginBottom: 16 }}>
              <h2 style={sectionTitle}>Join with a code</h2>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  value={joinCodeDraft}
                  onChange={(e) => setJoinCodeDraft(e.target.value.toUpperCase())}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && joinCodeDraft.trim().length >= 4) {
                      void groupsApi.join(joinCodeDraft).then(() => setJoinCodeDraft(""));
                    }
                  }}
                  maxLength={8}
                  placeholder="ABC123"
                  style={{
                    flex: 1,
                    border: "1px solid rgba(255,255,255,0.15)",
                    borderRadius: 7,
                    padding: "6px 8px",
                    fontSize: 12,
                    letterSpacing: 2,
                    background: "rgba(255,255,255,0.06)",
                    color: "#fff",
                    outline: "none",
                  }}
                />
                <button
                  style={{ ...chipStyle, opacity: joinCodeDraft.trim().length >= 4 ? 1 : 0.5 }}
                  disabled={joinCodeDraft.trim().length < 4}
                  onClick={() => void groupsApi.join(joinCodeDraft).then(() => setJoinCodeDraft(""))}
                >
                  Join
                </button>
              </div>
            </section>

            <section style={{ marginBottom: 8 }}>
              <h2 style={sectionTitle}>Leave a group</h2>
              {groupsApi.groups
                .filter((g) => g.groupType !== "global")
                .map((g) => (
                  <div key={g.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "3px 0", fontSize: 12 }}>
                    <span style={{ opacity: 0.75 }}>{g.name}</span>
                    <button
                      style={{ ...chipStyle, padding: "2px 8px", fontSize: 10, background: "rgba(248,113,113,0.25)" }}
                      onClick={() => {
                        if (activeRoomGroupId === g.id) onLeaveRoom();
                        void groupsApi.leave(g.id);
                      }}
                    >
                      leave
                    </button>
                  </div>
                ))}
              {groupsApi.groups.filter((g) => g.groupType !== "global").length === 0 && (
                <div style={{ fontSize: 11, opacity: 0.5 }}>Nothing to leave.</div>
              )}
            </section>

            <div style={{ fontSize: 10, opacity: 0.45 }}>
              In a room: your pet appears on your friends&apos; desktops (and theirs on
              yours), with chat, emotes, petting and ⚔️ battles.
            </div>
          </div>
        ) : view === "ranks" ? (
          <div className="mpc-no-scrollbar" style={{ flex: 1, overflowY: "auto", padding: "0 18px 18px" }}>
            <section style={{ marginBottom: 16 }}>
              <h2 style={sectionTitle}>Leaderboard — top care points</h2>
              {leaderboard.error && (
                <div style={{ fontSize: 11, color: "#f87171", marginBottom: 8 }}>⚠️ {leaderboard.error}</div>
              )}
              {leaderboard.loading && leaderboard.entries.length === 0 && (
                <div style={{ fontSize: 12, opacity: 0.6 }}>Loading…</div>
              )}
              {leaderboard.entries.map((entry, i) => (
                <div
                  key={`${entry.userId}-${entry.petType}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "5px 6px",
                    borderRadius: 7,
                    background: entry.isSelf ? "rgba(52,211,153,0.14)" : "transparent",
                    fontSize: 12,
                  }}
                >
                  <span style={{ width: 22, opacity: 0.6, fontWeight: 700 }}>
                    {i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`}
                  </span>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {entry.displayName}
                    <span style={{ opacity: 0.5 }}> · {entry.petName}</span>
                  </span>
                  <span title={STAGE_NAMES[entry.evolutionStage] ?? ""}>{STAGE_EMOJI[entry.evolutionStage] ?? "❔"}</span>
                  <span style={{ color: "#fbbf24", fontWeight: 700 }}>{Math.floor(entry.carePoints)} ⭐</span>
                </div>
              ))}
              {!leaderboard.loading && leaderboard.entries.length === 0 && !leaderboard.error && (
                <div style={{ fontSize: 12, opacity: 0.6 }}>Nobody on the board yet.</div>
              )}
            </section>

            <section style={{ marginBottom: 10 }}>
              <h2 style={sectionTitle}>Hall of fame</h2>
              {leaderboard.hallOfFame.map((entry) => (
                <div
                  key={entry.milestoneKey}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "5px 6px",
                    borderRadius: 7,
                    background: entry.isSelf ? "rgba(251,191,36,0.14)" : "rgba(255,255,255,0.04)",
                    marginBottom: 5,
                    fontSize: 12,
                  }}
                >
                  <span>🏛️</span>
                  <span style={{ flex: 1 }}>
                    <strong>{entry.displayName}</strong>
                    <span style={{ opacity: 0.6 }}>
                      {" — "}
                      {entry.milestoneKey === "first_final_evolution"
                        ? "first final evolution ever"
                        : entry.milestoneKey.startsWith("first_final_")
                          ? `first final ${entry.milestoneKey.replace("first_final_", "")}`
                          : entry.milestoneKey}
                    </span>
                  </span>
                </div>
              ))}
              {leaderboard.hallOfFame.length === 0 && !leaderboard.loading && (
                <div style={{ fontSize: 12, opacity: 0.6 }}>
                  No legends yet — the first pet to reach its final form claims a permanent spot here.
                </div>
              )}
            </section>
            <button style={{ ...chipStyle, width: "100%", textAlign: "center" }} onClick={() => void leaderboard.refresh()}>
              ↻ Refresh
            </button>
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
                        draggable={false}
                        // A plain click, not a held drag — grabs the piece
                        // (it then follows the cursor), click again anywhere
                        // to throw. stopPropagation keeps this SAME click
                        // from also bubbling to the window "click" listener
                        // grabFood attaches, which would instantly
                        // self-trigger the throw at the grab point.
                        onPointerDown={
                          canFeed && foodReady[i]
                            ? (e) => {
                                if (e.button !== 0) return;
                                onGrabFood(e, i);
                              }
                            : undefined
                        }
                        title={
                          !canFeed
                            ? "Not available right now"
                            : foodReady[i]
                              ? "Grab and drag to throw it to your pet"
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
                          // The pile's pieces overlap slightly (see
                          // FOOD_PILE_LAYOUT) — an already-taken, inert
                          // piece must not keep intercepting clicks meant
                          // for a ready piece behind/under it.
                          pointerEvents: canFeed && foodReady[i] ? "auto" : "none",
                        }}
                      >
                        🍖
                      </span>
                    ))}
                  </div>
                  <span style={{ fontSize: 11, opacity: 0.7 }}>
                    {nextFoodEta > 0 ? `next 🍖 in ${fmtEta(nextFoodEta)}` : "Drag to throw"}
                  </span>
                </div>

                {/* The ball — grab it and throw; comes back when the pet's done. */}
                <div style={{ ...itemBoxStyle, opacity: canPlayBall ? 1 : 0.45 }}>
                  <div style={{ height: 42, marginBottom: 4, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <span
                      draggable={false}
                      onPointerDown={
                        canPlayBall && ballReady
                          ? (e) => {
                              if (e.button !== 0) return;
                              onGrabBall(e);
                            }
                          : undefined
                      }
                      title={
                        !canPlayBall
                          ? "Not available right now"
                          : ballReady
                            ? "Grab and drag to throw it"
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
                  <span style={{ fontSize: 11, opacity: 0.7 }}>{ballReady ? "Drag to throw" : "Out playing…"}</span>
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
              📜 Quests and 🏆 achievements live in the header tabs — claim their rewards for bonus ⭐.
            </section>
          </div>
        )}

        {/* Persistent footer — outside the scrolling view content, so the
            version stays visible no matter which tab is open, and an update
            (once downloaded) is impossible to miss. */}
        <div
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            padding: "6px 14px",
            borderTop: "1px solid rgba(255,255,255,0.06)",
          }}
        >
          <span style={{ fontSize: 10, opacity: 0.4 }}>{appVersion ? `v${appVersion}` : ""}</span>
          {updateState === "ready" ? (
            <button
              onClick={onInstallUpdate}
              title="A new version has finished downloading — click to restart and install it"
              style={{
                cursor: "pointer",
                border: "none",
                borderRadius: 6,
                padding: "3px 9px",
                fontSize: 10,
                fontWeight: 700,
                background: "#22c55e",
                color: "#052e12",
              }}
            >
              ⬆ Update ready — restart
            </button>
          ) : updateState === "downloading" ? (
            <span style={{ fontSize: 10, opacity: 0.4 }}>Downloading update…</span>
          ) : null}
        </div>
      </div>
    </motion.div>
  );
}
