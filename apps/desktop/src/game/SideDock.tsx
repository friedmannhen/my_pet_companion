// The game's side dock, redesigned (Jul 2026) as a MULTI-RIBBON: a
// draggable column of 9 icon tabs pinned to a screen edge. The 🏠 Home tab
// toggles the whole menu: the Home panel (name/status header with the
// Send-Home nest slot, the 4 stat bars, and the ENTIRE Kitchen & toy box —
// food pile, ball, sponge, warm lamp, poop trash can) pops out beside the
// column at the ribbon's location and stays visible while open. The other
// 8 tabs (Quests/Achievements/Leaderboard/Groups/Friends/History/Pet
// Stats/Settings) share ONE mutually-exclusive secondary panel stacked
// directly beneath Home. Opening near the bottom of the screen auto-shifts
// the whole expanded stack upward so it always fully fits (the collapsed
// anchor the user dragged to is never rewritten).
//
// Food and ball are grabbed HERE (no Feed/Wash/Ball on the pet's radial
// menu): their trigger spans hand the live pointer event to GameView, which
// starts a framer dragControls drag on the always-mounted flying item.
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, animate, motion, useMotionValue } from "framer-motion";
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
  type HistoryEventCategory,
  type PetQuestCode,
  type PetSaveData,
  type QuestClaimState,
} from "@pet/core";
import houseIcon from "../assets/widget/house.png";
import settingsIcon from "../assets/widget/widget_settings.png";
import type { PetGame } from "./usePetGame";
import type { AuthState } from "../supabase/useAuth";
import type { SessionLease } from "../session/useSessionLease";
import type { InfoPanelId, RibbonSide } from "./useRibbonPrefs";
import {
  HUD_SCALE_FACTORS,
  HUD_SCALE_OPTIONS,
  PET_SCALE_OPTIONS,
  type FollowSpeed,
  type HudScale,
  type PetScale,
} from "./useGamePrefs";
import { useLeaderboard, LEADERBOARD_METRICS, type LeaderboardMetric } from "./useLeaderboard";
import { useFriends, type PlayerSearchResult } from "./useFriends";
import type { UseNotifications } from "../online/useNotifications";
import type { GroupInfo, UseGroups } from "./useGroups";
import { supabase } from "../supabase/client";
import { Tooltip } from "./Tooltip";
import { spriteFor, emojiFor } from "./petSprites";
import "./hud.css";

// Observes live presence count for a single group's room, without joining it
// or tracking the viewer's own presence. Lazy/on-demand (pass null when the
// row isn't expanded) so the groups menu doesn't open one Realtime channel
// per group just to show a member count.
//
// CRITICAL supabase-js behavior this must respect: `supabase.channel(topic)`
// dedupes by topic and returns the EXISTING instance if one exists — and
// removing a channel deregisters by TOPIC, not instance. So if the player is
// currently IN this group's room (useRoom owns a `pet-room:<id>` channel),
// creating/subscribing/removing our own "observer" here would hijack and
// then kill the live room connection. Instead: if a channel for the topic
// already exists, piggyback on it read-only (poll its presenceState, touch
// nothing); only create + own a channel when the topic is free, and only
// remove it if we're still the registered instance for the topic.
function useGroupPresenceCount(groupId: string | null): number | null {
  const [count, setCount] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    setCount(null);
    if (!supabase || !groupId) return;
    const topic = `realtime:pet-room:${groupId}`;
    const existing = supabase.getChannels().find((c) => c.topic === topic);

    if (existing) {
      // Someone else (the live room, usually) owns this topic — read only.
      const read = () => {
        const current = supabase!.getChannels().find((c) => c.topic === topic);
        if (current !== existing) {
          // Owner changed/removed — re-run the effect to rebind correctly.
          setNonce((n) => n + 1);
          return;
        }
        setCount(Object.keys(existing.presenceState()).length);
      };
      read();
      const id = setInterval(read, 1000);
      return () => clearInterval(id);
    }

    const channel = supabase.channel(`pet-room:${groupId}`, {
      config: { presence: { key: `observer-${Math.random().toString(36).slice(2)}` } },
    });
    channel.on("presence", { event: "sync" }, () => {
      setCount(Object.keys(channel.presenceState()).length);
    });
    channel.subscribe();
    return () => {
      // Only tear down if we're still the registered channel for this topic —
      // if useRoom's join() replaced us, removing our stale instance would
      // deregister the live room channel (removal filters by topic).
      const current = supabase!.getChannels().find((c) => c.topic === topic);
      if (current === channel) void supabase!.removeChannel(channel);
    };
  }, [groupId, nonce]);
  return count;
}

/** Live count of active chess games in a group — a one-shot query per
 *  mounted row (spectator SELECT rides is_group_member RLS). Cheap enough
 *  to run whenever the groups panel is open; no realtime subscription. */
function useGroupChessCount(groupId: string | null): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!supabase || !groupId) return;
    let cancelled = false;
    void supabase
      .from("chess_games")
      .select("id", { count: "exact", head: true })
      .eq("group_id", groupId)
      .eq("status", "active")
      .then(({ count: c }) => {
        if (!cancelled) setCount(c ?? 0);
      });
    return () => {
      cancelled = true;
    };
  }, [groupId]);
  return count;
}

/** One "My groups" card — its own component so every row can run
 *  useGroupPresenceCount unconditionally (hooks can't run in the parent's
 *  loop). Membership info is always visible now — no expand/collapse. */
function GroupRow({
  group: g,
  inThisRoom,
  canGoOnline,
  onEnterRoom,
  onLeaveRoom,
  onDelete,
}: {
  group: GroupInfo;
  inThisRoom: boolean;
  canGoOnline: boolean;
  onEnterRoom: (group: GroupInfo) => void;
  onLeaveRoom: () => void;
  onDelete: () => void;
}) {
  const liveCount = useGroupPresenceCount(g.id);
  const chessCount = useGroupChessCount(g.id);
  const [copied, setCopied] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const isOwner = g.role === "owner" && g.groupType !== "global";

  return (
    <div
      style={{
        borderRadius: 10,
        background: inThisRoom ? "rgba(52,211,153,0.12)" : "rgba(255,255,255,0.05)",
        border: inThisRoom ? "1px solid rgba(52,211,153,0.4)" : "1px solid transparent",
        padding: "8px 10px",
        marginBottom: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <strong
          style={{
            fontSize: 12,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            display: "flex",
            alignItems: "center",
            gap: 5,
            minWidth: 0,
            flex: 1,
          }}
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
            {g.groupType === "global" ? "🌍" : "👥"} {g.name}
          </span>
          {/* Live-presence badge: a single "{count} 🟢" numeric + online-icon
              readout (replaced the old repeated-dot-per-player format). */}
          {liveCount !== null && liveCount > 0 && (
            <Tooltip label={`${liveCount} ${liveCount === 1 ? "player" : "players"} in this room right now`}>
              <span style={{ fontSize: 10, opacity: 0.9, flexShrink: 0, fontWeight: 700 }}>
                {liveCount} 🟢
              </span>
            </Tooltip>
          )}
          {/* Active chess games badge — enter the room to see the picker
              and choose which one to resume/spectate. */}
          {chessCount > 0 && (
            <Tooltip label={`${chessCount} active chess game${chessCount === 1 ? "" : "s"} in this room — enter to play or spectate`}>
              <span style={{ fontSize: 10, opacity: 0.9, flexShrink: 0, fontWeight: 700, color: "#c4b5fd" }}>
                ♟️ {chessCount}
              </span>
            </Tooltip>
          )}
        </strong>
        {inThisRoom ? (
          <button style={{ ...chipStyle, background: "rgba(248,113,113,0.35)", flexShrink: 0 }} onClick={onLeaveRoom}>
            Leave room
          </button>
        ) : (
          <Tooltip label={canGoOnline ? "Go online in this group's room" : "Hatch your egg first"}>
            <button
              style={{ ...chipStyle, background: "rgba(52,211,153,0.35)", flexShrink: 0, opacity: canGoOnline ? 1 : 0.4 }}
              disabled={!canGoOnline}
              onClick={() => onEnterRoom(g)}
            >
              🌐 Enter room
            </button>
          </Tooltip>
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
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "✓ copied" : "copy"}
            </button>
          </>
        )}
        {g.groupType === "global" && <span>Everyone is here automatically.</span>}
        <span style={{ marginLeft: "auto", opacity: 0.6 }}>{g.role}</span>
      </div>
      {isOwner && (
        <div style={{ marginTop: 6 }}>
          {confirmingDelete ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10 }}>
              <span style={{ opacity: 0.8 }}>Delete this group? Everyone will be removed.</span>
              <button
                style={{ ...chipStyle, padding: "1px 6px", fontSize: 10, background: "rgba(248,113,113,0.45)" }}
                onClick={() => {
                  setConfirmingDelete(false);
                  onDelete();
                }}
              >
                Confirm
              </button>
              <button style={{ ...chipStyle, padding: "1px 6px", fontSize: 10 }} onClick={() => setConfirmingDelete(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button
              style={{ ...chipStyle, padding: "1px 6px", fontSize: 10, background: "rgba(248,113,113,0.2)" }}
              onClick={() => setConfirmingDelete(true)}
            >
              Delete group
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const rules = DEFAULT_PET_RULES;
const PANEL_TITLES: Record<InfoPanelId, string> = {
  quests: "📜 Quests",
  awards: "🏆 Achievements",
  ranks: "🌍 Leaderboard & hall of fame",
  groups: "👥 Groups & rooms",
  friends: "🤝 Friends",
  history: "🕓 History",
  petstats: "📊 Pet Stats",
  settings: "⚙️ Settings",
};

/** Ribbon tab order, top to bottom. "home" toggles the menu; the rest are
 *  secondary panels (deliberately UNGROUPED for now — grouping is a later
 *  product decision, do not pre-emptively consolidate). */
const RIBBON_TABS = [
  "home",
  "quests",
  "awards",
  "ranks",
  "groups",
  "friends",
  "history",
  "petstats",
  "settings",
] as const;
type RibbonTabId = (typeof RIBBON_TABS)[number];
const TAB_ICONS: Record<string, string> = {
  quests: "📜",
  awards: "🏆",
  ranks: "🌍",
  groups: "👥",
  friends: "🤝",
  history: "🕓",
  petstats: "📊",
};
const TAB_GAP = 6;
/** The ONE panel's fixed height (internal scroll), capped to the viewport
 *  at render time — computed from constants, never measured DOM rects. */
const PANEL_HEIGHT = 520;
/** Small inset between the panel top and the first ribbon tab while open. */
const TAB_COLUMN_TOP_INSET = 10;
const STAGE_NAMES = ["Egg", "Baby", "Adult", "Final"];
const STAGE_EMOJI = ["🥚", "🐣", "🐈", "😼"];
export const DRAWER_WIDTH = 340;
const TAB_SIZE = 46;
// How much wider the ACTIVE ribbon tab grows (toward the screen interior,
// away from the panel it's fused to) to read as "popped out" without ever
// detaching/shifting position — see the tab buttons' width style below.
const TAB_ACTIVE_GROW = 10;
const FILLET = 12;
const EDGE_MARGIN = 12;
const PANEL_BG = "rgba(21,21,27,0.96)";

const FOOD_PILE_LAYOUT = [
  { x: -14, y: 2, rotate: -14 },
  { x: 8, y: 5, rotate: 8 },
  { x: -4, y: -7, rotate: 18 },
  { x: 16, y: -4, rotate: -6 },
];

const HISTORY_CATEGORY_ICON: Record<HistoryEventCategory, string> = {
  care: "💛",
  quest: "🎯",
  achievement: "🏆",
  evolution: "🥚",
  penalty: "⚠️",
  social: "👥",
};

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

/** The pet's idle asset shown INSIDE the Home nest slot while the
 *  roaming pet is hidden there (Send Home quiet time). */
function NestedPetSprite({ petType, stage }: { petType: string; stage: number }) {
  const src = spriteFor(petType, stage);
  return src ? (
    <img
      src={src}
      width={40}
      height={40}
      draggable={false}
      alt=""
      className="pet-anim-idle-breathe"
      style={{ pointerEvents: "none", display: "block" }}
    />
  ) : (
    <span style={{ pointerEvents: "none" }}>{emojiFor(petType)}</span>
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
  /** Which secondary panel is open (null = none) — one at a time. */
  activePanel: InfoPanelId | null;
  /** Toggles: passing the already-active id closes the panel. */
  onSetActivePanel: (panel: InfoPanelId | null) => void;
  /** A downloaded update is pending and its toast was dismissed — keep a
   *  persistent badge on the tab so it isn't forgotten entirely. */
  updateBadge: boolean;
  /** Number of active chess games the player is in (tab badge). */
  chessBadgeCount: number;
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
  /** True while a dragged poop is directly over the trash can — enlarges/
   *  highlights it so the drop target is obvious before release. */
  poopHoverTrash: boolean;
  /** Egg phase only — enters warm mode (cursor becomes a light source). */
  canWarm: boolean;
  onStartWarm: () => void;
  soundEnabled: boolean;
  onToggleSound: () => void;
  followSpeed: FollowSpeed;
  onSetFollowSpeed: (speed: FollowSpeed) => void;
  /** HUD size level — scales ONLY the SideDock subtree (not the radial
   *  menu or tooltips). */
  hudScale: HudScale;
  onSetHudScale: (scale: HudScale) => void;
  /** Pet display size (% of default, shrink-only). */
  petScale: PetScale;
  onSetPetScale: (scale: PetScale) => void;
  /** True while the pet is parked at its Home nest (Send Home). */
  sentHome: boolean;
  /** True once the pet has fully tucked INTO the nest (roaming sprite
   *  hidden; the slot shows the idle asset and releases on click). */
  petNested: boolean;
  /** True while the pet/egg is being dragged directly over the nest slot
   *  — enlarges/highlights it so the drop target is obvious before release
   *  (same pattern as the Kitchen's poopHoverTrash for the trash can). */
  petHoverNest: boolean;
  onWakeFromNest: () => void;
  onRename: (name: string) => void;
  onSignOut: () => void;
  onQuit: () => void;
  appVersion: string;
  updateState: "idle" | "checking" | "downloading" | "ready" | "error";
  updatePercent: number | null;
  updateError: string | null;
  onInstallUpdate: () => void;
  groupsApi: UseGroups;
  /** Personal realtime inbox — friend/room-invite notifications. */
  notifications: UseNotifications;
  /** External "open at this view" request (notification clicks). */
  viewRequest: { view: "friends" | "groups"; n: number } | null;
  /** Group id of the room we're currently in (null = offline). */
  activeRoomGroupId: string | null;
  /** userIds currently present in my active room (for "already in your room"). */
  roomMemberIds: string[];
  /** friendId -> sentAt for outstanding room invites (spam-guard + UI state). */
  pendingRoomInvites: Record<string, number>;
  onInviteFriend: (friendId: string, group: { id: string; name: string; inviteCode: string | null }) => void;
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
  activePanel,
  onSetActivePanel,
  updateBadge,
  chessBadgeCount,
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
  poopHoverTrash,
  canWarm,
  onStartWarm,
  soundEnabled,
  onToggleSound,
  followSpeed,
  onSetFollowSpeed,
  hudScale,
  onSetHudScale,
  petScale,
  onSetPetScale,
  sentHome,
  petNested,
  petHoverNest,
  onWakeFromNest,
  onRename,
  onSignOut,
  onQuit,
  appVersion,
  updateState,
  updatePercent,
  updateError,
  onInstallUpdate,
  groupsApi,
  notifications,
  viewRequest,
  activeRoomGroupId,
  roomMemberIds,
  pendingRoomInvites,
  onInviteFriend,
  canGoOnline,
  onEnterRoom,
  onLeaveRoom,
}: SideDockProps) {
  const { save } = game;
  const [groupNameDraft, setGroupNameDraft] = useState("");
  // Leaving a GROUP with one of MY active chess games strands the game
  // (it's stored against group_id) — warn once, second click proceeds.
  const [leaveWarnGroupId, setLeaveWarnGroupId] = useState<string | null>(null);
  const [joinCodeDraft, setJoinCodeDraft] = useState("");
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
  const settingsActive =
    open && (activePanel === "settings" || activePanel === "groups" || activePanel === "friends");
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
  // Notification clicks steer the dock to a specific panel.
  useEffect(() => {
    if (viewRequest) onSetActivePanel(viewRequest.view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewRequest]);

  // Shared join-with-code submit: joins AND enters the room in one step
  // (typing a full 6-char code, Enter, and the button all use this).
  // Ref-guarded so a fast paste can't double-submit.
  const joiningCodeRef = useRef(false);
  const submitJoinCode = (code: string) => {
    const trimmed = code.trim();
    if (trimmed.length < 4 || joiningCodeRef.current) return;
    joiningCodeRef.current = true;
    void groupsApi
      .join(trimmed)
      .then((joined) => {
        setJoinCodeDraft("");
        if (joined) {
          game.logHistoryEvent({ category: "social", label: `Joined group "${joined.name}"` });
          onEnterRoom(joined);
        }
      })
      .finally(() => {
        joiningCodeRef.current = false;
      });
  };
  const myName = auth.displayName || auth.email?.split("@")[0] || "A friend";
  const [rankMetric, setRankMetric] = useState<LeaderboardMetric>("carePoints");
  const leaderboard = useLeaderboard(auth.userId, open && activePanel === "ranks", rankMetric);
  // Fetched whenever the dock opens (not just the friends view) so the nav
  // badge can show pending incoming requests.
  const friendsApi = useFriends(auth.userId, open);
  const [friendQuery, setFriendQuery] = useState("");
  const [friendResults, setFriendResults] = useState<PlayerSearchResult[]>([]);
  useEffect(() => {
    if (activePanel !== "friends") return;
    const q = friendQuery.trim();
    if (q.length < 2) {
      setFriendResults([]);
      return;
    }
    // Debounced autocomplete against profiles.name.
    const id = setTimeout(() => {
      void friendsApi.search(q).then(setFriendResults);
    }, 250);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [friendQuery, activePanel]);
  const claimableTotal = game.claimableQuestCount + game.achievements.claimableCount;

  // ── Multi-ribbon layout (round 2, per user feedback) ─────────────────────
  // Collapsed: ONLY the 🏠 Home tab shows, docked at the screen edge like
  // the original single-ribbon design. Opening it slides out ONE panel
  // (Home content by default) flush with the edge, with the tab column
  // FUSED to the panel's inner side (browser-tab style, rounded away from
  // the panel) — and the other 8 tabs stagger in one by one. Exactly ONE
  // panel is ever visible (Home included): activePanel === null means the
  // Home content, anything else swaps the same panel's body in place.
  const hudFactor = HUD_SCALE_FACTORS[hudScale];
  // Track the viewport so the open-stack clamps recompute on resize.
  const [viewportSize, setViewportSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const onResize = () => setViewportSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // All layout math runs in the HUD-scale wrapper's LOCAL coordinate space:
  // dividing the real viewport height by the scale factor keeps the
  // visually-scaled result inside the actual screen (the wrapper's origin
  // is pinned to the dock's top corner, so only height needs correcting).
  const localVH = viewportSize.h / hudFactor;

  const isRight = side === "right";
  const columnHeight = RIBBON_TABS.length * TAB_SIZE + (RIBBON_TABS.length - 1) * TAB_GAP;
  const panelH = Math.min(PANEL_HEIGHT, localVH - EDGE_MARGIN * 2);
  // The open stack = the panel + the tab column beside it (whichever is
  // taller) — clamp the open position so the WHOLE thing stays on-screen
  // even when the collapsed tab was dragged low. The user's dragged anchor
  // `y` itself is never rewritten.
  const stackH = Math.max(panelH, TAB_COLUMN_TOP_INSET + columnHeight);
  const openY = Math.min(Math.max(y, EDGE_MARGIN), Math.max(EDGE_MARGIN, localVH - EDGE_MARGIN - stackH));
  const anchorClamped = Math.max(EDGE_MARGIN, Math.min(localVH - TAB_SIZE - EDGE_MARGIN, y));

  // The column's vertical position: the user-dragged anchor while
  // collapsed, sliding to align with the panel top while open. Animated
  // imperatively (the same motion value the collapsed drag writes to).
  const tabY = useMotionValue(anchorClamped);
  useEffect(() => {
    const controls = animate(tabY, open ? openY + TAB_COLUMN_TOP_INSET : anchorClamped, {
      type: "spring",
      stiffness: 300,
      damping: 32,
    });
    return () => controls.stop();
  }, [open, openY, anchorClamped, tabY]);
  // Horizontal slide between the screen edge (collapsed) and the panel's
  // inner edge (open) — imperative for the same reason as tabY: the value
  // must be correct from the very first paint, not only once a mount
  // animation runs.
  const tabXClosed = isRight ? DRAWER_WIDTH : -DRAWER_WIDTH;
  const tabX = useMotionValue(open ? 0 : tabXClosed);
  useEffect(() => {
    const controls = animate(tabX, open ? 0 : tabXClosed, { type: "spring", stiffness: 300, damping: 32 });
    return () => controls.stop();
  }, [open, tabXClosed, tabX]);

  const nextThreshold =
    save.evolutionStage >= 3 ? null : rules.evolutionThresholds[(save.evolutionStage + 1) as 1 | 2 | 3];
  // Hour-aware age (no new storage — computed live from birthDate): "Xh"
  // under a day, "Xd Yh" from then on.
  const ageHours = Math.max(0, Math.floor((Date.now() - new Date(save.birthDate).getTime()) / 3_600_000));
  const ageText = ageHours < 24 ? `${ageHours}h` : `${Math.floor(ageHours / 24)}d ${ageHours % 24}h`;
  const nextFoodEta = foodReady.every(Boolean) ? 0 : Math.min(...foodEtaMs.filter((ms) => ms > 0));

  // Suppress tab clicks that were really the tail of a collapsed-tab drag.
  const draggingRef = useRef(false);

  const clickTab = (tab: RibbonTabId) => {
    if (draggingRef.current) return;
    if (tab === "home") {
      if (!open) {
        // Opening always lands on the Home content (one-at-a-time rule).
        if (activePanel !== null) onSetActivePanel(null);
        onToggle();
        return;
      }
      if (activePanel !== null) {
        // Viewing a secondary panel: Home tab switches back to Home.
        onSetActivePanel(null);
        return;
      }
      onToggle(); // already on Home → collapse everything
      return;
    }
    // Secondary tabs only exist while open. onSetActivePanel TOGGLES, so
    // clicking the active tab returns to the Home content (never zero
    // panels while open).
    onSetActivePanel(tab);
  };

  // Ribbon tooltips hang BESIDE the tabs (the top-centered default clipped
  // off the screen edge): over the panel while open, toward the screen
  // interior while collapsed at the edge.
  // Tooltips hang toward the screen's INTERIOR — opposite whichever edge
  // the dock is docked to — regardless of open/collapsed state (hanging
  // them toward the dock's own edge would run them off-screen).
  const tabTooltipPlacement = isRight ? ("left" as const) : ("right" as const);

  const homeContent = activePanel === null;

  return (
    // HUD-scale wrapper: ONE transform scales the entire SideDock subtree
    // as a single coordinate system (containing-block mechanic, deliberate).
    // The radial menu and Tooltips live OUTSIDE this wrapper (Tooltip
    // portals to document.body) so they stay unscaled by design.
    <div
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        zIndex: 25000,
        transform: hudFactor !== 1 ? `scale(${hudFactor})` : undefined,
        transformOrigin: isRight ? "top right" : "top left",
        color: "#fff",
        fontFamily: "'Segoe UI', system-ui, sans-serif",
      }}
    >
      {/* ── The panel: ONE at a time, flush with the screen edge ────────── */}
      <AnimatePresence>
        {open && (
          <motion.div
            key="dock-panel"
            data-interactive
            initial={{ x: isRight ? 46 : -46, opacity: 0 }}
            animate={{ x: 0, opacity: 1, y: openY }}
            exit={{ x: isRight ? 46 : -46, opacity: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 32 }}
            style={{
              position: "absolute",
              top: 0,
              y: openY,
              [isRight ? "right" : "left"]: EDGE_MARGIN,
              width: DRAWER_WIDTH,
              height: panelH,
              pointerEvents: "auto",
              borderRadius: 16,
              background: PANEL_BG,
              boxShadow: "0 10px 40px rgba(0,0,0,0.5)",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            {homeContent ? (
              <>
                {/* Home header: nest slot + name + status. The circular slot
                    is the Send-Home DROP target too — dragging the pet/egg
                    onto it (petHoverNest) enlarges/highlights it exactly
                    like the Kitchen's trash can does for a dragged poop.
                    Once the pet has tucked itself in (petNested), the slot
                    shows the pet's own idle asset and clicking it releases
                    the pet. */}
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 18px 8px", flexShrink: 0 }}>
                  <Tooltip
                    label={
                      petHoverNest
                        ? "Release to send home!"
                        : petNested
                          ? `${save.name} is snoozing in the nest — click to let them back out`
                          : sentHome
                            ? `${save.name} is heading home…`
                            : "Your pet's home spot — use the radial menu's 🏠 Send Home, or drag your pet/egg here"
                    }
                  >
                    <motion.div
                      data-homeslot
                      onClick={petNested ? onWakeFromNest : undefined}
                      animate={{ scale: petHoverNest ? 1.35 : 1 }}
                      transition={{ type: "spring", stiffness: 420, damping: 20 }}
                      style={{
                        position: "relative",
                        width: 46,
                        height: 46,
                        borderRadius: "50%",
                        border: petHoverNest
                          ? "2px solid rgba(52,211,153,0.85)"
                          : sentHome
                            ? "2px solid rgba(52,211,153,0.7)"
                            : "2px dashed rgba(255,255,255,0.25)",
                        boxShadow: petHoverNest ? "0 0 0 2px rgba(52,211,153,0.85) inset" : undefined,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 22,
                        background: petHoverNest
                          ? "rgba(52,211,153,0.22)"
                          : sentHome
                            ? "rgba(52,211,153,0.12)"
                            : "rgba(255,255,255,0.04)",
                        opacity: sentHome || petHoverNest ? 1 : 0.6,
                        flexShrink: 0,
                        userSelect: "none",
                        cursor: petNested ? "pointer" : "default",
                        overflow: "hidden",
                      }}
                    >
                      {petNested ? (
                        <NestedPetSprite petType={save.petType} stage={save.evolutionStage} />
                      ) : (
                        "🪺"
                      )}
                    </motion.div>
                  </Tooltip>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                      <h1 style={{ fontSize: 18, margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {save.name}
                      </h1>
                      <span style={{ fontSize: 12, opacity: 0.6, flexShrink: 0 }}>{STAGE_NAMES[save.evolutionStage]}</span>
                    </div>
                    <div style={{ fontSize: 11, opacity: 0.5 }}>
                      {!save.isAlive ? "deceased" : petNested ? "resting in the nest 🪺" : save.isSleeping ? "sleeping 💤" : "awake"}
                    </div>
                  </div>
                </div>

                <div className="mpc-no-scrollbar" style={{ flex: 1, overflowY: "auto", padding: "0 18px 12px" }}>
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

                  <section style={{ marginBottom: 14 }}>
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

                  <section style={{ marginBottom: 6 }}>
                    <h2 style={sectionTitle}>Kitchen &amp; toy box</h2>
                    <div style={{ display: "flex", gap: 8 }}>
                      {/* Egg phase: no feeding or ball — the warm lamp replaces them. */}
                      {game.isEgg && (
                        <div style={{ ...itemBoxStyle, opacity: canWarm ? 1 : 0.45 }}>
                          <div style={{ height: 42, marginBottom: 4, display: "flex", alignItems: "center", justifyContent: "center" }}>
                            <Tooltip
                              label={
                                canWarm
                                  ? "Take the lamp and warm your egg"
                                  : petNested
                                    ? "Your egg is resting in the nest — let it out first"
                                    : "Not available right now"
                              }
                            >
                              <span
                                onClick={canWarm ? onStartWarm : undefined}
                                style={{
                                  fontSize: 28,
                                  lineHeight: 1,
                                  userSelect: "none",
                                  cursor: canWarm ? "pointer" : "default",
                                  filter: canWarm ? "drop-shadow(0 0 6px rgba(253,224,71,0.8))" : "grayscale(0.6)",
                                }}
                              >
                                💡
                              </span>
                            </Tooltip>
                          </div>
                          <span style={{ fontSize: 11, opacity: 0.7 }}>Warm the egg</span>
                        </div>
                      )}
                      {/* Food pile — grab a piece straight off the pile and throw it. */}
                      {!game.isEgg && (
                        <div style={{ ...itemBoxStyle, opacity: canFeed ? 1 : 0.45 }}>
                          <div style={{ position: "relative", height: 42, marginBottom: 4 }}>
                            {FOOD_PILE_LAYOUT.map((p, i) => (
                              <Tooltip
                                key={i}
                                label={
                                  !canFeed
                                    ? "Not available right now"
                                    : foodReady[i]
                                      ? "Grab and drag to throw it to your pet"
                                      : `Regrows in ${fmtEta(foodEtaMs[i] ?? 0)}`
                                }
                              >
                                <span
                                  draggable={false}
                                  onPointerDown={
                                    canFeed && foodReady[i]
                                      ? (e) => {
                                        if (e.button !== 0) return;
                                        onGrabFood(e, i);
                                      }
                                      : undefined
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
                                    pointerEvents: canFeed && foodReady[i] ? "auto" : "none",
                                  }}
                                >
                                  🍖
                                </span>
                              </Tooltip>
                            ))}
                          </div>
                          <span style={{ fontSize: 11, opacity: 0.7 }}>
                            {nextFoodEta > 0 ? `next 🍖 in ${fmtEta(nextFoodEta)}` : "Drag to throw"}
                          </span>
                        </div>
                      )}

                      {/* The ball — grab it and throw; comes back when the pet's done. */}
                      {!game.isEgg && (
                        <div style={{ ...itemBoxStyle, opacity: canPlayBall ? 1 : 0.45 }}>
                          <div style={{ height: 42, marginBottom: 4, display: "flex", alignItems: "center", justifyContent: "center" }}>
                            <Tooltip
                              label={
                                !canPlayBall
                                  ? "Not available right now"
                                  : ballReady
                                    ? "Grab and drag to throw it"
                                    : "The pet is playing with it"
                              }
                            >
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
                            </Tooltip>
                          </div>
                          <span style={{ fontSize: 11, opacity: 0.7 }}>{ballReady ? "Drag to throw" : "Out playing…"}</span>
                        </div>
                      )}

                      {/* The sponge — click to enter scrub mode. */}
                      <div style={{ ...itemBoxStyle, opacity: canClean ? 1 : 0.45 }}>
                        <div style={{ height: 42, marginBottom: 4, display: "flex", alignItems: "center", justifyContent: "center" }}>
                          <Tooltip
                            label={
                              canClean
                                ? "Grab the sponge and scrub your pet"
                                : petNested
                                  ? "Your pet is resting in the nest — let them out first"
                                  : save.cleanliness >= 100
                                    ? "Already squeaky clean"
                                    : "Not available right now"
                            }
                          >
                            <span
                              onClick={canClean ? onStartClean : undefined}
                              style={{
                                fontSize: 28,
                                lineHeight: 1,
                                userSelect: "none",
                                cursor: canClean ? "pointer" : "default",
                              }}
                            >
                              🧽
                            </span>
                          </Tooltip>
                        </div>
                        <span style={{ fontSize: 11, opacity: 0.7 }}>Scrub clean</span>
                      </div>

                      {/* The trash can — drop-target for poop cleanup
                          ([data-trashcan]; attribute-based hit-test in
                          GameView, highlighted while a poop hovers it). */}
                      {!game.isEgg && (
                        <div
                          data-trashcan
                          style={{
                            ...itemBoxStyle,
                            transition: "background 0.15s ease, box-shadow 0.15s ease",
                            background: poopHoverTrash ? "rgba(52,211,153,0.22)" : itemBoxStyle.background,
                            boxShadow: poopHoverTrash ? "0 0 0 2px rgba(52,211,153,0.85) inset" : undefined,
                          }}
                        >
                          <div style={{ height: 42, marginBottom: 4, display: "flex", alignItems: "center", justifyContent: "center" }}>
                            <Tooltip label="Drag your pet's poop here to clean it up">
                              <motion.span
                                animate={{ scale: poopHoverTrash ? 1.35 : 1 }}
                                transition={{ type: "spring", stiffness: 420, damping: 20 }}
                                style={{ fontSize: 28, lineHeight: 1, userSelect: "none", display: "inline-block" }}
                              >
                                🗑️
                              </motion.span>
                            </Tooltip>
                          </div>
                          <span style={{ fontSize: 11, opacity: 0.7 }}>{poopHoverTrash ? "Release to clean up!" : "Poop goes here"}</span>
                        </div>
                      )}
                    </div>
                  </section>
                </div>

                {/* Persistent footer — version + update state. */}
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
                    <Tooltip label="A new version has finished downloading — click to restart and install it">
                      <button
                        onClick={onInstallUpdate}
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
                    </Tooltip>
                  ) : updateState === "downloading" ? (
                    <span style={{ fontSize: 10, opacity: 0.4 }}>
                      Downloading update{updatePercent !== null ? ` — ${updatePercent}%` : "…"}
                    </span>
                  ) : updateState === "error" ? (
                    <Tooltip label={updateError ?? null}>
                      <span style={{ fontSize: 10, opacity: 0.5, color: "#f87171" }}>
                        ⚠️ Update check failed
                      </span>
                    </Tooltip>
                  ) : null}
                </div>
              </>
            ) : (
              <>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "12px 18px 8px",
                    flexShrink: 0,
                  }}
                >
                  <strong style={{ fontSize: 13, opacity: 0.85 }}>{PANEL_TITLES[activePanel]}</strong>
                  {/* No close "✕" here — this IS a tab now (clicking the
                      same ribbon tab again, or the Home tab, is the way
                      back — a redundant close button was confusing). */}
                </div>
            {activePanel === "settings" ? (
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
                    Drag the tab column up/down to set where the menu sits.
                  </div>
                  <div style={{ fontSize: 11, opacity: 0.55, margin: "10px 0 4px" }}>HUD size</div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {HUD_SCALE_OPTIONS.map((o) => (
                      <button
                        key={o.value}
                        onClick={() => onSetHudScale(o.value)}
                        style={{
                          ...chipStyle,
                          flex: 1,
                          textAlign: "center",
                          padding: "7px 4px",
                          fontSize: 11,
                          background: hudScale === o.value ? "rgba(52,211,153,0.35)" : "rgba(255,255,255,0.1)",
                        }}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, opacity: 0.55, margin: "10px 0 4px" }}>Pet size</div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {PET_SCALE_OPTIONS.map((v) => (
                      <button
                        key={v}
                        onClick={() => onSetPetScale(v)}
                        style={{
                          ...chipStyle,
                          flex: 1,
                          textAlign: "center",
                          padding: "7px 4px",
                          fontSize: 11,
                          background: petScale === v ? "rgba(52,211,153,0.35)" : "rgba(255,255,255,0.1)",
                        }}
                      >
                        {v}%
                      </button>
                    ))}
                  </div>
                </section>

                <section style={{ marginBottom: 18 }}>
                  <h2 style={sectionTitle}>Game</h2>
                  <button style={{ ...chipStyle, width: "100%", textAlign: "left" }} onClick={onToggleSound}>
                    {soundEnabled ? "🔊 Sounds: on" : "🔇 Sounds: off"}
                  </button>
                  <div style={{ fontSize: 11, opacity: 0.55, margin: "10px 0 4px" }}>Follow Me speed</div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {(["slow", "normal", "fast"] as const).map((s) => (
                      <button
                        key={s}
                        onClick={() => onSetFollowSpeed(s)}
                        style={{
                          ...chipStyle,
                          flex: 1,
                          textAlign: "center",
                          background: followSpeed === s ? "rgba(52,211,153,0.35)" : "rgba(255,255,255,0.1)",
                        }}
                      >
                        {{ slow: "🐌 Slow", normal: "🐾 Normal", fast: "⚡ Fast" }[s]}
                      </button>
                    ))}
                  </div>
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
                      <Tooltip
                        label={
                          lease.conflict
                            ? `Active on ${lease.conflict.deviceType} — click to take over here`
                            : "Active elsewhere"
                        }
                      >
                        <button
                          style={{ ...chipStyle, background: "rgba(248,113,113,0.35)", textAlign: "left" }}
                          onClick={lease.forceTakeover}
                        >
                          ⚠️ Take over this device
                        </button>
                      </Tooltip>
                    )}
                    {lease.status === "kicked" && (
                      <Tooltip label="Your account signed in elsewhere and this device was disconnected. Click to reconnect here — it will disconnect that other device instead.">
                        <button
                          style={{ ...chipStyle, background: "rgba(127,29,29,0.6)", textAlign: "left" }}
                          onClick={lease.forceTakeover}
                        >
                          🔒 Disconnected — click to reconnect here
                        </button>
                      </Tooltip>
                    )}
                    <div style={{ fontSize: 11, opacity: 0.5 }}>{auth.email}</div>
                    {/* Both are "leaving" actions so both read red — sign out the
                    softer shade (account-level), quit the harsher one (kills
                    the whole overlay). */}
                    <button
                      style={{ ...chipStyle, textAlign: "left", background: "rgba(248,113,113,0.22)", color: "#fca5a5" }}
                      onClick={onSignOut}
                    >
                      🚪 Sign out
                    </button>
                    <button
                      style={{ ...chipStyle, textAlign: "left", background: "rgba(153,27,27,0.45)", color: "#f87171" }}
                      onClick={onQuit}
                    >
                      ⛔ Quit
                    </button>
                  </div>
                </section>

                <section style={{ opacity: 0.45, fontSize: 11 }}>
                  More options land here as the game grows.
                </section>
              </div>
            ) : activePanel === "quests" ? (
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
            ) : activePanel === "awards" ? (
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
                              onClick={() => {
                                game.achievements.claim(code);
                                game.logHistoryEvent({ category: "achievement", label: `Achievement claimed: ${def.title}` });
                              }}
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
            ) : activePanel === "groups" ? (
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
                  {groupsApi.groups.map((g) => (
                    <GroupRow
                      key={g.id}
                      group={g}
                      inThisRoom={activeRoomGroupId === g.id}
                      canGoOnline={canGoOnline}
                      onEnterRoom={onEnterRoom}
                      onLeaveRoom={onLeaveRoom}
                      onDelete={() => {
                        if (activeRoomGroupId === g.id) onLeaveRoom();
                        void groupsApi.deleteGroup(g.id).then((ok) => {
                          if (ok) game.logHistoryEvent({ category: "social", label: `Deleted group "${g.name}"` });
                        });
                      }}
                    />
                  ))}
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
                          const nameAtSubmit = groupNameDraft;
                          void groupsApi.create(groupNameDraft).then((created) => {
                            setGroupNameDraft("");
                            if (created) game.logHistoryEvent({ category: "social", label: `Created group "${nameAtSubmit}"` });
                          });
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
                      onClick={() => {
                        const nameAtSubmit = groupNameDraft;
                        void groupsApi.create(groupNameDraft).then((created) => {
                          setGroupNameDraft("");
                          if (created) game.logHistoryEvent({ category: "social", label: `Created group "${nameAtSubmit}"` });
                        });
                      }}
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
                      onChange={(e) => {
                        const code = e.target.value.toUpperCase();
                        setJoinCodeDraft(code);
                        // Codes are exactly 6 chars — auto-join (and enter the
                        // room) the moment a full code is typed/pasted, no extra
                        // click. Ref-guarded against double-submit on fast paste.
                        if (code.trim().length === 6) submitJoinCode(code);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && joinCodeDraft.trim().length >= 4) submitJoinCode(joinCodeDraft);
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
                      onClick={() => submitJoinCode(joinCodeDraft)}
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
                      <div key={g.id} style={{ padding: "3px 0", fontSize: 12 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span style={{ opacity: 0.75 }}>{g.name}</span>
                          <button
                            style={{ ...chipStyle, padding: "2px 8px", fontSize: 10, background: "rgba(248,113,113,0.25)" }}
                            onClick={() => {
                              void (async () => {
                                // Warn first if one of MY chess games lives here.
                                if (leaveWarnGroupId !== g.id && supabase && auth.userId) {
                                  const { count } = await supabase
                                    .from("chess_games")
                                    .select("id", { count: "exact", head: true })
                                    .eq("group_id", g.id)
                                    .eq("status", "active")
                                    .or(`player_a_id.eq.${auth.userId},player_b_id.eq.${auth.userId}`);
                                  if ((count ?? 0) > 0) {
                                    setLeaveWarnGroupId(g.id);
                                    return;
                                  }
                                }
                                setLeaveWarnGroupId(null);
                                if (activeRoomGroupId === g.id) onLeaveRoom();
                                void groupsApi.leave(g.id).then((ok) => {
                                  if (ok) game.logHistoryEvent({ category: "social", label: `Left group "${g.name}"` });
                                });
                              })();
                            }}
                          >
                            {leaveWarnGroupId === g.id ? "leave anyway" : "leave"}
                          </button>
                        </div>
                        {leaveWarnGroupId === g.id && (
                          <div style={{ fontSize: 10, color: "#fde68a", marginTop: 2 }}>
                            ⚠️ You have an active chess game in this group — leaving strands it (give up or
                            propose a cancel first).
                          </div>
                        )}
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
            ) : activePanel === "friends" ? (
              <div className="mpc-no-scrollbar" style={{ flex: 1, overflowY: "auto", padding: "0 18px 18px" }}>
                <section style={{ marginBottom: 16 }}>
                  <h2 style={sectionTitle}>Find players</h2>
                  <input
                    value={friendQuery}
                    onChange={(e) => setFriendQuery(e.target.value)}
                    maxLength={40}
                    placeholder="Search player name…"
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      border: "1px solid rgba(255,255,255,0.15)",
                      borderRadius: 7,
                      padding: "6px 8px",
                      fontSize: 12,
                      background: "rgba(255,255,255,0.06)",
                      color: "#fff",
                      outline: "none",
                    }}
                  />
                  {friendQuery.trim().length >= 2 && (
                    <div style={{ marginTop: 6 }}>
                      {friendResults.length === 0 ? (
                        <div style={{ fontSize: 11, opacity: 0.55 }}>No players found.</div>
                      ) : (
                        friendResults.map((r) => (
                          <div
                            key={r.userId}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              padding: "5px 8px",
                              borderRadius: 7,
                              background: "rgba(255,255,255,0.05)",
                              marginBottom: 4,
                              fontSize: 12,
                            }}
                          >
                            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {r.name}
                            </span>
                            {r.relation === "friend" ? (
                              <span style={{ fontSize: 10, opacity: 0.6 }}>already friends</span>
                            ) : r.relation === "pending" ? (
                              <span style={{ fontSize: 10, opacity: 0.6 }}>request pending</span>
                            ) : (
                              <button
                                style={{ ...chipStyle, padding: "4px 8px", fontSize: 11 }}
                                onClick={() => {
                                  void friendsApi.request(r.userId);
                                  notifications.sendTo(r.userId, { kind: "friend_request", fromName: myName });
                                  setFriendQuery("");
                                }}
                              >
                                ➕ Add
                              </button>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </section>

                {friendsApi.error && (
                  <div style={{ fontSize: 11, color: "#f87171", marginBottom: 8 }}>⚠️ {friendsApi.error}</div>
                )}

                {friendsApi.incoming.length > 0 && (
                  <section style={{ marginBottom: 16 }}>
                    <h2 style={sectionTitle}>Friend requests</h2>
                    {friendsApi.incoming.map((f) => (
                      <div
                        key={f.userId}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "6px 8px",
                          borderRadius: 7,
                          background: "rgba(52,211,153,0.1)",
                          marginBottom: 4,
                          fontSize: 12,
                        }}
                      >
                        <span style={{ flex: 1 }}>{f.name}</span>
                        <button
                          style={{ ...chipStyle, padding: "4px 8px", fontSize: 11, background: "rgba(52,211,153,0.3)" }}
                          onClick={() => {
                            void friendsApi.accept(f.userId);
                            notifications.sendTo(f.userId, { kind: "friend_accepted", fromName: myName });
                          }}
                        >
                          ✓ Accept
                        </button>
                        <button
                          style={{ ...chipStyle, padding: "4px 8px", fontSize: 11, background: "rgba(248,113,113,0.25)" }}
                          onClick={() => void friendsApi.decline(f.userId)}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </section>
                )}

                <section style={{ marginBottom: 10 }}>
                  <h2 style={sectionTitle}>My friends</h2>
                  {friendsApi.loading && friendsApi.friends.length === 0 && (
                    <div style={{ fontSize: 12, opacity: 0.6 }}>Loading…</div>
                  )}
                  {!friendsApi.loading && friendsApi.friends.length === 0 && (
                    <div style={{ fontSize: 12, opacity: 0.6 }}>No friends yet — search a player above.</div>
                  )}
                  {friendsApi.friends.map((f) => (
                    <div
                      key={f.userId}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "6px 8px",
                        borderRadius: 7,
                        background: "rgba(255,255,255,0.05)",
                        marginBottom: 4,
                        fontSize: 12,
                      }}
                    >
                      <span>🤝</span>
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
                      {/* Invite to my current room — only shown while actually in one.
                      Three states: already present / invite pending (spam-guarded,
                      clears on their response or after 60s) / inviteable. */}
                      {activeRoomGroupId &&
                        (() => {
                          const g = groupsApi.groups.find((gr) => gr.id === activeRoomGroupId);
                          if (!g) return null;
                          if (roomMemberIds.includes(f.userId)) {
                            return (
                              <span style={{ fontSize: 10, opacity: 0.7, fontWeight: 700, flexShrink: 0 }}>
                                ✅ In your room
                              </span>
                            );
                          }
                          if (f.userId in pendingRoomInvites) {
                            return (
                              <span
                                style={{ ...chipStyle, padding: "4px 8px", fontSize: 11, opacity: 0.6, cursor: "default" }}
                              >
                                ⏳ Invited…
                              </span>
                            );
                          }
                          return (
                            <Tooltip label={`Invite ${f.name} to ${g.name}`}>
                              <button
                                style={{ ...chipStyle, padding: "4px 8px", fontSize: 11, background: "rgba(52,211,153,0.25)" }}
                                onClick={() => onInviteFriend(f.userId, g)}
                              >
                                🌐 Invite
                              </button>
                            </Tooltip>
                          );
                        })()}
                      <Tooltip label={`Remove ${f.name} from friends`}>
                        <button
                          style={{ ...chipStyle, padding: "4px 8px", fontSize: 11, background: "rgba(248,113,113,0.2)" }}
                          onClick={() => void friendsApi.remove(f.userId)}
                        >
                          Remove
                        </button>
                      </Tooltip>
                    </div>
                  ))}
                  {friendsApi.outgoing.length > 0 && (
                    <div style={{ fontSize: 10, opacity: 0.5, marginTop: 6 }}>
                      Waiting on: {friendsApi.outgoing.map((f) => f.name).join(", ")}
                    </div>
                  )}
                </section>
              </div>
            ) : activePanel === "history" ? (
              <div className="mpc-no-scrollbar" style={{ flex: 1, overflowY: "auto", padding: "0 18px 18px" }}>
                <section style={{ marginBottom: 8 }}>
                  <h2 style={sectionTitle}>History</h2>
                  {(save.history ?? []).length === 0 ? (
                    <div style={{ fontSize: 12, opacity: 0.6 }}>No history yet — go feed your pet!</div>
                  ) : (
                    (save.history ?? []).map((h) => (
                      <div
                        key={h.id}
                        style={{
                          borderRadius: 10,
                          background: "rgba(255,255,255,0.05)",
                          padding: "8px 10px",
                          marginBottom: 8,
                        }}
                      >
                        {/* Description gets the full row width as a single
                        non-wrapping line; the timestamp sits on its own row. */}
                        <Tooltip label={h.label}>
                          <div
                            style={{
                              fontSize: 12,
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {HISTORY_CATEGORY_ICON[h.category]} {h.label}
                          </div>
                        </Tooltip>
                        <div style={{ fontSize: 10, opacity: 0.55, marginTop: 2 }}>{new Date(h.at).toLocaleString()}</div>
                      </div>
                    ))
                  )}
                </section>
              </div>
            ) : activePanel === "ranks" ? (
              <div className="mpc-no-scrollbar" style={{ flex: 1, overflowY: "auto", padding: "0 18px 18px" }}>
                <section style={{ marginBottom: 16 }}>
                  <h2 style={sectionTitle}>Leaderboard</h2>
                  {/* Metric filter pills (ported from the old hub's leaderboard) */}
                  <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
                    {LEADERBOARD_METRICS.map((m) => (
                      <button
                        key={m.metric}
                        onClick={() => setRankMetric(m.metric)}
                        style={{
                          cursor: "pointer",
                          border: "none",
                          borderRadius: 999,
                          padding: "4px 10px",
                          fontSize: 11,
                          fontWeight: 700,
                          color: "#fff",
                          background: rankMetric === m.metric ? "rgba(52,211,153,0.35)" : "rgba(255,255,255,0.08)",
                        }}
                      >
                        {m.icon} {m.label}
                      </button>
                    ))}
                  </div>
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
                      <Tooltip label={STAGE_NAMES[entry.evolutionStage] ?? ""}>
                        <span>{STAGE_EMOJI[entry.evolutionStage] ?? "❔"}</span>
                      </Tooltip>
                      <span style={{ color: "#fbbf24", fontWeight: 700 }}>
                        {rankMetric === "evolutionStage"
                          ? `Stage ${entry.evolutionStage}/3 ✨`
                          : rankMetric === "interactions"
                            ? `${entry.interactions} 🤝`
                            : rankMetric === "targetToss"
                              ? `${entry.bestScore ?? "—"} 📏 · ${entry.gamesWon}W`
                              : rankMetric === "rps" || rankMetric === "chess"
                                ? `${entry.gamesWon}W / ${entry.gamesPlayed}`
                                : `${Math.floor(entry.carePoints)} ⭐`}
                      </span>
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
            ) : activePanel === "petstats" ? (
              <div className="mpc-no-scrollbar" style={{ flex: 1, overflowY: "auto", padding: "0 18px 18px" }}>
                <section style={{ marginBottom: 16 }}>
                  <h2 style={sectionTitle}>Progress</h2>
                  <Stat label="Age" value={ageText} />
                  <Stat label="Stage" value={STAGE_NAMES[save.evolutionStage] ?? "?"} />
                  <Stat label="Hatched" value={save.hatched ? "yes" : "no"} />
                </section>

                <section style={{ marginBottom: 16 }}>
                  <h2 style={sectionTitle}>Care history</h2>
                  <Stat label="🍖 Feeds" value={save.feedCount} />
                  <Stat label="🧼 Washes" value={save.washCount} />
                  <Stat label="🤗 Pets" value={save.petCount} />
                  <Stat label="⚾ Ball throws" value={save.throwBallCount} />
                  <Stat label="💩 Poops cleaned" value={save.poopCleanedCount ?? 0} />
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
              </div>
            ) : null}
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── The ribbon tab column, fused to the panel's inner edge ────────
          Collapsed: only the 🏠 Home tab, docked at the screen edge (the
          original single-ribbon look, draggable). Open: the column slides
          inward flush against the panel and the other 8 tabs stagger in
          one by one; the ACTIVE tab shares the panel's background and
          protrudes slightly, reading as physically attached to its menu. */}
      <motion.div
        data-interactive
        drag={open ? false : "y"}
        dragConstraints={{ top: EDGE_MARGIN, bottom: Math.max(EDGE_MARGIN, localVH - TAB_SIZE - EDGE_MARGIN) }}
        dragMomentum={false}
        dragElastic={0}
        onDragStart={() => {
          draggingRef.current = true;
        }}
        onDragEnd={() => {
          // Cleared a tick later so the click that ends the drag can't also
          // fire a tab action.
          setTimeout(() => {
            draggingRef.current = false;
          }, 0);
          onYChange(tabY.get());
        }}
        style={{
          position: "absolute",
          top: 0,
          x: tabX,
          y: tabY,
          [isRight ? "right" : "left"]: EDGE_MARGIN + DRAWER_WIDTH,
          width: TAB_SIZE + 6,
          display: "flex",
          flexDirection: "column",
          gap: TAB_GAP,
          alignItems: isRight ? "flex-end" : "flex-start",
          pointerEvents: "auto",
          cursor: open ? "default" : "grab",
          touchAction: "none",
        }}
      >
        {/* Home tab — always present; the master open/close toggle. */}
        <Tooltip
          label={
            !open
              ? "My Pet Companion — open the menu"
              : activePanel === null
                ? "Close the menu"
                : "Back to Home"
          }
          placement={tabTooltipPlacement}
        >
          <button
            onClick={() => clickTab("home")}
            style={{
              position: "relative",
              // Active tab "pops" wider (stretched toward the screen
              // interior) instead of shifting position — the column's
              // flex alignment anchors the PANEL-facing edge, so growing
              // width only extends the free (rounded) edge outward,
              // keeping the fused join intact.
              width: open && activePanel === null ? TAB_SIZE + TAB_ACTIVE_GROW : TAB_SIZE,
              height: TAB_SIZE,
              border: "none",
              borderRadius: isRight ? "14px 0 0 14px" : "0 14px 14px 0",
              cursor: open ? "pointer" : "grab",
              background: PANEL_BG,
              boxShadow: open && activePanel === null ? "none" : "0 4px 16px rgba(0,0,0,0.4)",
              opacity: !open || activePanel === null ? 1 : 0.75,
              transition: "width 0.18s ease",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#fff",
              flexShrink: 0,
            }}
          >
            <img src={houseIcon} alt="" width={26} height={26} draggable={false} style={{ pointerEvents: "none" }} />
            <Tooltip label={game.syncError ?? game.syncStatus} placement={tabTooltipPlacement}>
              <span
                style={{
                  position: "absolute",
                  top: 4,
                  [isRight ? "left" : "right"]: 4,
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: SYNC_COLOR[game.syncStatus] ?? "#9ca3af",
                }}
              />
            </Tooltip>
            {updateBadge && (
              <Tooltip label="An update is downloaded and ready — open the update notice or the Home footer to install" placement={tabTooltipPlacement}>
                <span
                  style={{
                    position: "absolute",
                    bottom: -3,
                    [isRight ? "left" : "right"]: 1,
                    minWidth: 14,
                    height: 14,
                    borderRadius: 999,
                    background: "#22c55e",
                    color: "#052e12",
                    fontSize: 9,
                    fontWeight: 900,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "0 3px",
                  }}
                >
                  ⬆
                </span>
              </Tooltip>
            )}
            {chessBadgeCount > 0 && (
              <Tooltip label={`${chessBadgeCount} ongoing chess game${chessBadgeCount === 1 ? "" : "s"}`} placement={tabTooltipPlacement}>
                <span
                  style={{
                    position: "absolute",
                    top: -3,
                    [isRight ? "left" : "right"]: 1,
                    minWidth: 14,
                    height: 14,
                    borderRadius: 999,
                    background: "#a78bfa",
                    color: "#1e1b4b",
                    fontSize: 9,
                    fontWeight: 900,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "0 3px",
                  }}
                >
                  ♟{chessBadgeCount > 1 ? chessBadgeCount : ""}
                </span>
              </Tooltip>
            )}
            {!open && claimableTotal > 0 && (
              <Tooltip label={`${claimableTotal} reward${claimableTotal === 1 ? "" : "s"} ready to claim`} placement={tabTooltipPlacement}>
                <span
                  style={{
                    position: "absolute",
                    bottom: -3,
                    [isRight ? "right" : "left"]: 1,
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
              </Tooltip>
            )}
            {/* Nest badge — visible collapsed or open, so it's never
                forgotten that the pet is tucked away for quiet time. */}
            {petNested && (
              <Tooltip label="Your pet is resting in the nest — open Home to let them out" placement={tabTooltipPlacement}>
                <span
                  style={{
                    position: "absolute",
                    top: -3,
                    [isRight ? "right" : "left"]: 1,
                    minWidth: 14,
                    height: 14,
                    borderRadius: 999,
                    background: "#78350f",
                    color: "#fde68a",
                    fontSize: 9,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "0 3px",
                  }}
                >
                  🪺
                </span>
              </Tooltip>
            )}
          </button>
        </Tooltip>

        {/* The 8 secondary tabs — hidden while collapsed, staggering in one
            by one from the panel side when the menu opens. */}
        <AnimatePresence>
          {open &&
            RIBBON_TABS.filter((t) => t !== "home").map((tab, i) => {
              const active = activePanel === tab;
              const badge =
                tab === "quests"
                  ? game.claimableQuestCount
                  : tab === "awards"
                    ? game.achievements.claimableCount
                    : tab === "friends"
                      ? friendsApi.incoming.length
                      : 0;
              return (
                <motion.div
                  key={tab}
                  initial={{ x: isRight ? 70 : -70, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  exit={{ x: isRight ? 70 : -70, opacity: 0, transition: { duration: 0.15 } }}
                  transition={{ type: "spring", stiffness: 320, damping: 26, delay: 0.05 + i * 0.045 }}
                >
                  <Tooltip label={PANEL_TITLES[tab as InfoPanelId]} placement={tabTooltipPlacement}>
                    <button
                      onClick={() => clickTab(tab)}
                      style={{
                        position: "relative",
                        // Same "pop wider, don't shift" treatment as the
                        // Home tab above.
                        width: active ? TAB_SIZE + TAB_ACTIVE_GROW : TAB_SIZE,
                        height: TAB_SIZE,
                        border: "none",
                        borderRadius: isRight ? "14px 0 0 14px" : "0 14px 14px 0",
                        cursor: "pointer",
                        background: active ? PANEL_BG : "rgba(21,21,27,0.78)",
                        boxShadow: active ? "none" : "0 4px 16px rgba(0,0,0,0.4)",
                        opacity: active ? 1 : 0.75,
                        transition: "width 0.18s ease",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 19,
                        color: "#fff",
                        flexShrink: 0,
                      }}
                    >
                      {tab === "settings" ? (
                        <img src={settingsIcon} alt="" width={18} height={18} draggable={false} style={{ pointerEvents: "none" }} />
                      ) : (
                        TAB_ICONS[tab]
                      )}
                      <Badge count={badge} />
                    </button>
                  </Tooltip>
                </motion.div>
              );
            })}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
