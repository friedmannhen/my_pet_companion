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
  const wasOverrideActiveRef = useRef(false);

  useEffect(() => {
    const off = window.overlay.onCursor(({ x, y }) => {
      // A capture-mode interaction (feed-throw, wash-scrub) is driving
      // clickability directly — don't fight it every 80ms.
      if (isClickableOverrideActive()) {
        wasOverrideActiveRef.current = true;
        return;
      }
      const el = document.elementFromPoint(x, y);
      const interactive = !!el?.closest("[data-interactive]");
      // The override unconditionally forces window.overlay.setClickable(false)
      // the instant it ends (see clickableOverride.ts's callers), completely
      // bypassing clickableRef below — which was last written before the
      // override started and never updated while it was active (the early
      // return above skips every tick). If the cursor happens to be over an
      // interactive element with the SAME interactive-ness it had before the
      // override began, the "only call on change" check would wrongly think
      // nothing changed and never re-assert clickable=true, leaving the
      // window stuck click-through despite the cursor sitting right on the
      // drawer (confirmed live: needing to close/reopen the drawer to
      // "unstick" it was exactly this desync). Force one fresh, unconditional
      // resync on the first tick after an override ends.
      const justEndedOverride = wasOverrideActiveRef.current;
      wasOverrideActiveRef.current = false;
      if (interactive !== clickableRef.current || justEndedOverride) {
        clickableRef.current = interactive;
        window.overlay.setClickable(interactive);
        setClickable(interactive);
      }
    });
    return off;
  }, []);

  return clickable;
}
