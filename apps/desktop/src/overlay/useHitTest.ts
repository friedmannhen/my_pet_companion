import { useEffect, useRef, useState } from "react";
import { isClickableOverrideActive } from "./clickableOverride";

/**
 * Toggles OS-level click-through based on whether the cursor is over an
 * element marked `data-interactive`. Main process streams the OS cursor
 * position (~12Hz) because neither mouseenter nor raw mousemove reach an
 * ignored window on Win10 + Electron 33 despite `{ forward: true }`
 * (verified in the overlay spike).
 *
 * Must be called unconditionally at the App root. If it's only mounted
 * inside a conditionally-rendered subtree (e.g. the signed-in game view),
 * every other screen — auth card, loading, error states — becomes
 * permanently click-through and unusable, since nothing is polling the
 * cursor to ever turn clicks back on.
 */
export function useHitTest(): boolean {
  const [clickable, setClickable] = useState(false);
  const clickableRef = useRef(false);

  useEffect(() => {
    const off = window.overlay.onCursor(({ x, y }) => {
      // A capture-mode interaction (feed-throw, wash-scrub) is driving
      // clickability directly — don't fight it every 80ms.
      if (isClickableOverrideActive()) return;
      const el = document.elementFromPoint(x, y);
      const interactive = !!el?.closest("[data-interactive]");
      if (interactive !== clickableRef.current) {
        clickableRef.current = interactive;
        window.overlay.setClickable(interactive);
        setClickable(interactive);
      }
    });
    return off;
  }, []);

  return clickable;
}
