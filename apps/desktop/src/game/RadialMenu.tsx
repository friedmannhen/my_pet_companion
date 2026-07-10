// The pet's on-screen interaction surface (plan intent: the overlay shows
// ONLY a compact interaction menu — QA-hub-style — never a data readout;
// stats/progress live in the slide-out StatsDrawer instead).
// Segments pop outward from the pet in a staggered spring, matching the
// QA hub's radial pet panel feel.
import { motion } from "framer-motion";

export interface RadialAction {
  key: string;
  icon: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  highlight?: boolean;
  /** 0 (just used) .. 1 (ready) — when set, draws a filling ring + a small
   * "Xm"/"Xs" countdown badge so a cooldown is obvious without hovering. */
  cooldownProgress?: number;
  cooldownLabel?: string;
}

const SEGMENT_SIZE = 40;
const RING_R = 22;
const RING_CIRC = 2 * Math.PI * RING_R;
// Actions fan out along a downward-facing arc below the pet (like a tray of
// controls at its feet) rather than spreading around the full circle —
// keeps them out of the way of the pet's face/body and away from the
// SideDock tab.
const ARC_CENTER = Math.PI / 2; // straight down
const ARC_SPAN = (140 * Math.PI) / 180;

export function RadialMenu({
  actions,
  radius = 74,
}: {
  actions: RadialAction[];
  radius?: number;
}) {
  return (
    <>
      {actions.map((action, i) => {
        const angle =
          actions.length === 1
            ? ARC_CENTER
            : ARC_CENTER - ARC_SPAN / 2 + i * (ARC_SPAN / (actions.length - 1));
        const x = Math.cos(angle) * radius;
        const y = Math.sin(angle) * radius;
        const hasCooldown = action.cooldownProgress !== undefined;
        return (
          <motion.div
            key={action.key}
            initial={{ opacity: 0, scale: 0, x: 0, y: 0 }}
            animate={{ opacity: 1, scale: 1, x, y }}
            exit={{ opacity: 0, scale: 0, x: 0, y: 0 }}
            transition={{ type: "spring", stiffness: 320, damping: 22, delay: i * 0.03 }}
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              width: SEGMENT_SIZE,
              height: SEGMENT_SIZE,
              marginLeft: -SEGMENT_SIZE / 2,
              marginTop: -SEGMENT_SIZE / 2,
            }}
          >
            {hasCooldown && (
              <svg
                width={RING_R * 2 + 6}
                height={RING_R * 2 + 6}
                style={{
                  position: "absolute",
                  left: SEGMENT_SIZE / 2 - RING_R - 3,
                  top: SEGMENT_SIZE / 2 - RING_R - 3,
                  transform: "rotate(-90deg)",
                  pointerEvents: "none",
                }}
              >
                <circle
                  cx={RING_R + 3}
                  cy={RING_R + 3}
                  r={RING_R}
                  fill="none"
                  stroke="rgba(255,255,255,0.15)"
                  strokeWidth={3}
                />
                <circle
                  cx={RING_R + 3}
                  cy={RING_R + 3}
                  r={RING_R}
                  fill="none"
                  stroke="#67e8f9"
                  strokeWidth={3}
                  strokeLinecap="round"
                  strokeDasharray={RING_CIRC}
                  strokeDashoffset={RING_CIRC * (1 - (action.cooldownProgress ?? 0))}
                  style={{ transition: "stroke-dashoffset 1s linear" }}
                />
              </svg>
            )}
            <button
              data-interactive
              onClick={(e) => {
                e.stopPropagation();
                if (!action.disabled) action.onClick();
              }}
              disabled={action.disabled}
              title={action.label}
              style={{
                width: SEGMENT_SIZE,
                height: SEGMENT_SIZE,
                borderRadius: "50%",
                border: "none",
                cursor: action.disabled ? "default" : "pointer",
                opacity: action.disabled ? 0.45 : 1,
                background: action.highlight ? "rgba(52,211,153,0.92)" : "rgba(28,28,34,0.94)",
                color: "#fff",
                fontSize: 18,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                boxShadow: "0 3px 10px rgba(0,0,0,0.45)",
              }}
            >
              {action.icon}
            </button>
            {hasCooldown && action.disabled && action.cooldownLabel && (
              <div
                style={{
                  position: "absolute",
                  top: SEGMENT_SIZE + 2,
                  left: "50%",
                  transform: "translateX(-50%)",
                  whiteSpace: "nowrap",
                  fontSize: 10,
                  fontWeight: 700,
                  padding: "1px 6px",
                  borderRadius: 999,
                  background: "rgba(8,47,73,0.9)",
                  color: "#67e8f9",
                  pointerEvents: "none",
                }}
              >
                {action.cooldownLabel}
              </div>
            )}
          </motion.div>
        );
      })}
    </>
  );
}
