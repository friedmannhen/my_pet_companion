// Edge-docked control tab — collapsed, it's just the house icon (ported
// from ERP_QA_HUB's public/pets/Widget assets) pinned to a screen edge.
// Click toggles the StatsDrawer open/closed directly (no intermediate
// popover menu — account actions live inside the drawer itself now). Drag
// it anywhere on screen and release to redock it to whichever edge is
// nearer, at whatever height you dropped it — same motion-value + drag
// pattern as the pet and food (see usePetMovement.ts), so the same
// "position tracks the cursor while a real drag is happening" trick keeps
// it from losing hit-testing mid-drag.
//
// While the drawer is open, the tab isn't draggable — instead it animates
// from the bare screen edge to sit flush against the drawer's outer edge,
// staying in lockstep with the drawer's own open/close slide so it reads as
// a handle attached to the drawer rather than a separate floating button.
import { useEffect, useRef } from "react";
import { animate, motion, useMotionValue } from "framer-motion";
import houseIcon from "../assets/widget/house.png";
import type { RibbonSide } from "./useRibbonPrefs";
import { DRAWER_WIDTH } from "./StatsDrawer";

const TAB_SIZE = 46;
const DRAWER_MARGIN = 12;

const SYNC_COLOR: Record<string, string> = {
  offline: "#9ca3af",
  loading: "#fbbf24",
  synced: "#34d399",
  error: "#f87171",
};

function dockedX(side: RibbonSide, open: boolean): number {
  if (side === "right") {
    return open ? window.innerWidth - TAB_SIZE - (DRAWER_WIDTH + DRAWER_MARGIN) : window.innerWidth - TAB_SIZE;
  }
  return open ? DRAWER_WIDTH + DRAWER_MARGIN : 0;
}

export function RibbonDock({
  side,
  y,
  onDock,
  open,
  onToggle,
  syncStatus,
  syncError,
}: {
  side: RibbonSide;
  y: number;
  onDock: (side: RibbonSide, y: number) => void;
  open: boolean;
  onToggle: () => void;
  syncStatus: string;
  syncError: string | null;
}) {
  const tabX = useMotionValue(dockedX(side, open));
  const tabY = useMotionValue(y);
  const draggingRef = useRef(false);

  // Slide to the docked (or drawer-attached) position whenever side/open
  // changes — this is what makes the tab look pushed along with the drawer.
  // Skipped while a drag is actively in progress so it doesn't fight the
  // user's cursor.
  useEffect(() => {
    if (draggingRef.current) return;
    const a = animate(tabX, dockedX(side, open), { type: "spring", stiffness: 320, damping: 30 });
    return () => a.stop();
  }, [side, open, tabX]);

  useEffect(() => {
    if (draggingRef.current) return;
    const a = animate(tabY, y, { type: "spring", stiffness: 320, damping: 30 });
    return () => a.stop();
  }, [y, tabY]);

  return (
    <motion.button
      data-interactive
      drag={!open}
      dragMomentum={false}
      dragElastic={0}
      onDragStart={() => {
        draggingRef.current = true;
      }}
      onDragEnd={() => {
        draggingRef.current = false;
        const nextSide: RibbonSide = tabX.get() + TAB_SIZE / 2 < window.innerWidth / 2 ? "left" : "right";
        const nextY = Math.max(12, Math.min(window.innerHeight - TAB_SIZE - 12, tabY.get()));
        onDock(nextSide, nextY);
      }}
      onClick={onToggle}
      whileTap={{ scale: 0.92 }}
      title="My Pet Companion"
      style={{
        position: "fixed",
        left: 0,
        top: 0,
        x: tabX,
        y: tabY,
        cursor: open ? "pointer" : "grab",
        border: "none",
        width: TAB_SIZE,
        height: TAB_SIZE,
        borderRadius: side === "right" ? "14px 0 0 14px" : "0 14px 14px 0",
        background: "rgba(20,20,26,0.88)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
        zIndex: 24000,
      }}
    >
      <img src={houseIcon} alt="" width={26} height={26} draggable={false} />
      <span
        title={syncError ?? syncStatus}
        style={{
          position: "absolute",
          top: 5,
          [side === "right" ? "left" : "right"]: 5,
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: SYNC_COLOR[syncStatus] ?? "#9ca3af",
        }}
      />
    </motion.button>
  );
}
