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
}

const SEGMENT_SIZE = 40;

export function RadialMenu({
  actions,
  radius = 74,
}: {
  actions: RadialAction[];
  radius?: number;
}) {
  const angleStep = (2 * Math.PI) / actions.length;

  return (
    <>
      {actions.map((action, i) => {
        // Start at the top, go clockwise.
        const angle = -Math.PI / 2 + i * angleStep;
        const x = Math.cos(angle) * radius;
        const y = Math.sin(angle) * radius;
        return (
          <motion.button
            key={action.key}
            data-interactive
            initial={{ opacity: 0, scale: 0, x: 0, y: 0 }}
            animate={{ opacity: 1, scale: 1, x, y }}
            exit={{ opacity: 0, scale: 0, x: 0, y: 0 }}
            transition={{ type: "spring", stiffness: 320, damping: 22, delay: i * 0.03 }}
            onClick={(e) => {
              e.stopPropagation();
              if (!action.disabled) action.onClick();
            }}
            disabled={action.disabled}
            title={action.label}
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              width: SEGMENT_SIZE,
              height: SEGMENT_SIZE,
              marginLeft: -SEGMENT_SIZE / 2,
              marginTop: -SEGMENT_SIZE / 2,
              borderRadius: "50%",
              border: "none",
              cursor: action.disabled ? "default" : "pointer",
              opacity: action.disabled ? 0.35 : 1,
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
          </motion.button>
        );
      })}
    </>
  );
}
