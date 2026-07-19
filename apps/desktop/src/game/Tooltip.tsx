// Shared hover-tooltip component — the one and only way to show a hover
// hint in this app. RULE (see pet-game-mechanics skill): never add a bare
// `title="..."` attribute to a DOM element in this codebase; wrap it in
// <Tooltip label="..."> instead. The native browser/OS tooltip is slow to
// appear, unstyled, and (in an Electron overlay with custom click-through
// hit-testing) easy to forget is even there. This component gives every
// hint the same themed, quick-fading look instead.
//
// Implementation notes:
// - Clones the single child element and attaches mouse handlers + a ref,
//   rather than wrapping it in an extra <span>. Several existing `title=`
//   usages are on elements that are themselves `position: absolute` (badges
//   anchored to a parent tab button) — introducing a new wrapper with
//   `position: relative` would silently change what they're positioned
//   relative to. Cloning avoids touching layout entirely.
// - The floating label itself is `position: fixed` with coordinates read
//   from the child's own `getBoundingClientRect()` at show-time, and always
//   `pointerEvents: "none"` — so it's never picked up by useHitTest's
//   `document.elementFromPoint` poll and never needs `data-interactive`.
// - Rendered through a portal straight onto `document.body`, NOT inline in
//   the component tree. `position: fixed` is only relative to the viewport
//   if every ancestor is untransformed — but a `transform` (or `filter`/
//   `perspective`/`will-change: transform`) on ANY ancestor creates a new
//   containing block that fixed descendants become relative to instead.
//   This app is full of such ancestors: plain `transform: translateX(-50%)`
//   centering (RoomBar's bottom bar, GameView's toasts) AND framer-motion's
//   `x`/`y`/`scale` motion values (SideDock's draggable tab, any
//   `motion.div`) all apply an inline `transform`. Without the portal, a
//   Tooltip nested inside any of those renders wildly offset from the
//   element it's supposed to point at (confirmed live: every tooltip on
//   RoomBar's bottom-center bar, which is centered via translateX(-50%)).
//   Portaling to `document.body` guarantees the tooltip's containing block
//   is always the real viewport, regardless of what it's nested inside.
import { cloneElement, isValidElement, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";

export interface TooltipProps {
    /** Falsy (undefined/null/"") renders the child with no tooltip at all —
     *  mirrors how `title={maybeUndefined}` used to just no-op. */
    label?: string | null;
    children: ReactElement;
    /** "left"/"right" hang the label beside the child (used by the ribbon
     *  tabs, whose top-centered labels clipped off the screen edge). */
    placement?: "top" | "bottom" | "left" | "right";
}

const SHOW_DELAY_MS = 350;

export function Tooltip({ label, children, placement = "top" }: TooltipProps) {
    const [rect, setRect] = useState<DOMRect | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const elRef = useRef<HTMLElement | null>(null);

    const clearTimer = () => {
        if (timerRef.current) clearTimeout(timerRef.current);
    };

    if (!label || !isValidElement(children)) return children ?? null;

    const child = children as ReactElement<Record<string, unknown>>;
    const existingRef = (child as unknown as { ref?: unknown }).ref;

    const merged = cloneElement(child, {
        ref: (node: HTMLElement | null) => {
            elRef.current = node;
            if (typeof existingRef === "function") existingRef(node);
            else if (existingRef && typeof existingRef === "object") (existingRef as { current: unknown }).current = node;
        },
        onMouseEnter: (e: React.MouseEvent) => {
            (child.props.onMouseEnter as ((e: React.MouseEvent) => void) | undefined)?.(e);
            clearTimer();
            timerRef.current = setTimeout(() => {
                if (elRef.current) setRect(elRef.current.getBoundingClientRect());
            }, SHOW_DELAY_MS);
        },
        onMouseLeave: (e: React.MouseEvent) => {
            (child.props.onMouseLeave as ((e: React.MouseEvent) => void) | undefined)?.(e);
            clearTimer();
            setRect(null);
        },
        onPointerDown: (e: React.PointerEvent) => {
            (child.props.onPointerDown as ((e: React.PointerEvent) => void) | undefined)?.(e);
            clearTimer();
            setRect(null);
        },
    } as Record<string, unknown>);

    return (
        <>
            {merged}
            {createPortal(
                <AnimatePresence>
                    {rect && (
                        <motion.div
                            initial={{
                                opacity: 0,
                                y: placement === "top" ? 4 : placement === "bottom" ? -4 : 0,
                                x: placement === "left" ? 4 : placement === "right" ? -4 : 0,
                            }}
                            animate={{ opacity: 1, y: 0, x: 0 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.12 }}
                            style={{
                                position: "fixed",
                                left:
                                    placement === "right"
                                        ? rect.right + 8
                                        : placement === "left"
                                          ? undefined
                                          : rect.left + rect.width / 2,
                                right: placement === "left" ? window.innerWidth - rect.left + 8 : undefined,
                                top:
                                    placement === "bottom"
                                        ? rect.bottom + 7
                                        : placement === "left" || placement === "right"
                                          ? rect.top + rect.height / 2
                                          : undefined,
                                bottom: placement === "top" ? window.innerHeight - rect.top + 7 : undefined,
                                transform:
                                    placement === "left" || placement === "right"
                                        ? "translateY(-50%)"
                                        : "translateX(-50%)",
                                padding: "5px 9px",
                                borderRadius: 8,
                                background: "rgba(17,17,23,0.96)",
                                color: "#fff",
                                fontSize: 11,
                                fontWeight: 600,
                                lineHeight: 1.35,
                                textAlign: "center",
                                maxWidth: 240,
                                pointerEvents: "none",
                                zIndex: 40000,
                                boxShadow: "0 6px 18px rgba(0,0,0,0.45)",
                                fontFamily: "'Segoe UI', system-ui, sans-serif",
                            }}
                        >
                            {label}
                        </motion.div>
                    )}
                </AnimatePresence>,
                document.body,
            )}
        </>
    );
}
