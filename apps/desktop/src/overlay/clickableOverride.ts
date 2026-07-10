// Escape hatch for useHitTest's normal cursor-poll-driven click-through
// toggling. Interactions that need the WHOLE screen to accept mouse input
// for a moment — holding food to throw it, scrubbing the pet with a sponge —
// set this true and drive window.overlay.setClickable(true) themselves so
// native DOM mousemove/mouseup fire reliably (they don't at all while the
// window is click-through, which is the normal state outside the pet's
// hitbox). A module-level flag rather than React context: this is a rare,
// short-lived, single-owner-at-a-time override, not shared app state.
let overrideActive = false;

export function setClickableOverride(active: boolean): void {
  overrideActive = active;
}

export function isClickableOverrideActive(): boolean {
  return overrideActive;
}
