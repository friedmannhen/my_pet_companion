---
name: pet-game-mechanics
description: >
  Deep implementation knowledge of my_pet_companion's care-action mechanics —
  feed, ball, wash, and pet wander/drag/follow movement — in
  apps/desktop/src/game/GameView.tsx, useConsumables.ts, usePetMovement.ts,
  useGamePrefs.ts, SideDock.tsx, and the click-through overlay layer
  (overlay/clickableOverride.ts, overlay/useHitTest.ts). Covers the
  framer-motion grab-drag-throw handoff pattern, the ballistic-arc throw
  physics with squash-and-stretch, the petBusy/feedPhase/ballPhase state
  machine, the Stay/Free-Roam movement-mode toggle, the Follow-Me cursor-
  chase rAF loop, and several React footguns already discovered and fixed in
  this exact codebase. USE THIS SKILL whenever the task touches: feeding, the
  ball, washing/scrubbing, dragging the pet or any thrown item, throw/arc/
  bounce animation tuning, the SideDock's "Kitchen & toy box" items, petBusy /
  feedPhase / ballPhase, the radial menu's Stay / Free Roam / Follow Me
  buttons, the Settings view's Follow Me speed picker, click-through /
  overlay clickability bugs ("clicks aren't registering", "menu is stuck",
  "need to close and reopen to interact"), adding/auditing hover tooltips
  (this app has a strict house rule: always use the shared `Tooltip`
  component, never a bare `title=` attribute), or before making ANY change to
  useConsumables.ts's takeFood/takeBall/returnBall — a proven-broken pattern
  is documented below and must not be reintroduced even by accident.
---

# Pet game mechanics (feed / ball / wash / movement)

This game is a transparent, click-through, always-on-top Electron overlay
(`apps/desktop/electron/main.ts`) rendering a React app
(`apps/desktop/src/game/GameView.tsx`). Every mechanic below lives in that
one very large component plus a handful of hooks. Read this before touching
any of it — the "obvious" fix for a feed/ball/drag bug in this codebase has
been wrong multiple times in ways that took real debugging to uncover.

## File map

- `GameView.tsx` — the whole game loop: feed, ball, wash, radial menu, pet
  drag, evolution, all wired together. ~1500+ lines; search by feature
  comment header (`// ── Feed & Ball`, `// ── Wash`, etc.).
- `useConsumables.ts` — food-pile respawn timers + ball-out-or-in-slot state.
- `usePetMovement.ts` — wander, drag-glide-throw for the pet itself,
  `walkTo()` (used by feed/ball/evolve sequences to make the pet walk
  somewhere and await arrival), and the Follow-Me cursor-chase rAF loop
  (`following`/`followSpeed` options — see "Movement" below).
- `useGamePrefs.ts` — persisted local prefs: sound, `movementMode`
  ("free"/"static" — the Stay/Free-Roam toggle; `setMovementMode` exists
  for direct sets, used by Send Home), `followSpeed`, `hudScale`
  ("sm"/"md"/"lg"/"xl" → `HUD_SCALE_FACTORS`, scales ONLY the SideDock
  subtree), and `petScale` (100/90/80/70 — shrink-only multiplier on the
  pet's display scale).
- `SideDock.tsx` — the MULTI-RIBBON dock (fourth pass, late Jul 2026, after
  a further round of user feedback on iteration 3): the active tab is
  highlighted by background/opacity ONLY now — the earlier ±5px "fused"
  x-offset on the active tab was removed (read as "losing connection with
  the window"); ribbon tab BUTTONS are plain `<button>`s again (only the
  8-secondary-tabs' entrance stagger still uses a `motion.div` wrapper for
  the AnimatePresence slide-in — the buttons themselves no longer need
  `motion.button`). Secondary panels no longer have a "✕" close button
  (redundant — the tab itself, or the Home tab, is the way back). Tooltip
  placement is now simply `isRight ? "left" : "right"` — ALWAYS the
  interior side opposite whichever edge the dock is docked to, independent
  of open/collapsed state (an earlier open-state-dependent formula hung
  tooltips off-screen in some configurations). The Home tab also carries a
  🪺 badge (opposite corner from the chess-games badge) whenever
  `petNested` is true, so a hidden pet is never silently forgotten while
  the ribbon is collapsed. The ACTIVE tab (Home or whichever secondary tab)
  now grows `TAB_ACTIVE_GROW` (10px) wider instead of using background
  alone — since the column's flex alignment anchors the panel-facing edge
  (`alignItems: flex-end`/`flex-start` per side), growing `width` only
  extends the FREE (rounded, screen-interior-facing) edge outward, so it
  reads as "popped out/stretched" while staying visually fused to the
  panel — a plain CSS `transition: "width 0.18s ease"` handles the
  animation (no framer motion value needed, unlike the earlier x-offset
  attempt this replaced).
- `SideDock.tsx` (third iteration, for context) — the MULTI-RIBBON dock
  after user feedback on the stacked-panels version): COLLAPSED shows only
  the 🏠 Home tab docked at the screen edge (the original single-ribbon
  look, draggable vertically, anchor `y` persisted). Opening slides out
  exactly ONE panel flush with the edge, with the whole tab column FUSED to
  the panel's inner side (rounded away from the panel, active tab shares
  PANEL_BG + protrudes ~5px — reads as physically attached); the other 8
  tabs (quests/awards/ranks/groups/friends/history/petstats/settings)
  STAGGER IN one by one (AnimatePresence, ~45ms delay steps, from the panel
  side). STRICT one-panel-at-a-time INCLUDING Home: `activePanel === null`
  = Home content (name/status header with the `[data-homeslot]` nest slot,
  4 stat bars, the ENTIRE Kitchen & toy box incl. `[data-trashcan]`, and
  the version footer); any other id swaps the same panel's body in place
  (a secondary panel's ✕ goes BACK to Home, not closed). Tab semantics:
  Home opens (resetting to Home content) / switches back to Home / closes;
  a secondary tab toggles itself (same tab again → Home). The column's
  x AND y are IMPERATIVE motion values (`animate(tabX/tabY, ...)`) — not
  animate-props — so the first paint is already correct; open aligns the
  column with the clamped `openY` (auto-shift keeps panel+column fully
  on-screen; the dragged anchor is never rewritten); collapsed drag is
  enabled only while closed (`drag={open ? false : "y"}`, `draggingRef`
  suppresses drag-tail clicks). Ribbon tooltips use the Tooltip component's
  side placements ("right" over the panel while open, interior-facing while
  collapsed) — the top-centered default clipped off the screen edge. The
  whole subtree sits in ONE fixed inset-0 wrapper applying the HUD scale
  via `transform: scale()` (containing-block mechanic, deliberate); layout
  math divides by the factor (`localVH`) to stay on the real screen. The
  pile/ball/sponge spans are still just trigger elements handing off to
  GameView's always-mounted flying items; grabbing food/ball closes
  nothing.
- `useRibbonPrefs.ts` — persisted dock side + collapsed anchor `y` +
  `activePanel`. `kitchenOpen` is GONE (the Kitchen lives inside Home now).
  Local-only, never synced.
- `overlay/clickableOverride.ts` + `overlay/useHitTest.ts` — the
  click-through toggling system. See "Click-through overlay model" below —
  this is the #1 source of "why isn't my new drag gesture receiving mouse
  events" bugs.
- `Tooltip.tsx` — the shared hover-tooltip component; see the RULE section
  below. Used everywhere a `title=` attribute would otherwise have gone.

## Click-through overlay model — read this before adding ANY new drag gesture

The Electron window is `setIgnoreMouseEvents(true)` by default (click-through
— clicks pass to whatever app is behind it). `useHitTest.ts` polls the OS
cursor position (~12Hz, streamed from `main.ts` via `window.overlay.onCursor`
— native mousemove doesn't reach an ignored window reliably on Win10 +
Electron 33) and toggles `window.overlay.setClickable(bool)` based on whether
`document.elementFromPoint(x, y)` is inside a `[data-interactive]` element.

For a gesture that needs the **whole screen** clickable for its duration —
dragging food/ball anywhere, scrubbing with the sponge — call
`setClickableOverride(true)` (a module-level flag) AND
`window.overlay.setClickable(true)` yourself at grab time, and reverse both
at the end. `useHitTest`'s poll early-returns while the override is active so
it doesn't fight you.

**The bug we found and fixed (Nov 2026 session):** `useHitTest` only calls
`window.overlay.setClickable()` when its cached `clickableRef` value
*changes*. That cache freezes while the override is active (the poll skips
every tick). When the override ends, cleanup code force-sets
`window.overlay.setClickable(false)` directly, bypassing the cache. If the
cursor is back over an interactive element with the *same* interactive-ness
it had before the drag started, the cache thinks nothing changed and never
re-asserts `true` — the window stays stuck click-through even with the
cursor sitting right on the drawer. Symptom: "I have to close and reopen the
menu to interact with it again." Fix (already applied in `useHitTest.ts`):
track whether the override was active on the previous tick, and force one
unconditional resync the instant it ends. **If you add a new
`setClickableOverride`-using gesture and see stuck-clickability complaints,
this is almost certainly NOT a new bug — check the resync logic is intact
first.**

## Grab → drag → release-to-throw pattern

Food and ball both use this exact pattern (see `throwFood`/`grabFood` and
`runBallFetch`/`grabBall` in GameView.tsx). It replaced an earlier
click-to-auto-toss design once the *real* root cause of "grab doesn't work"
turned out to be a completely unrelated bug (see next section) — don't
re-abandon drag-throw for a click-only design if it seems flaky; check the
`useConsumables` return values first.

1. **`useDragControls()` handoff, not native drag.** The floating item
   (`<motion.div drag dragControls={...} dragListener={false} ...>`) is
   always mounted at `zIndex: 26000`, invisible (`opacity: 0`,
   `pointerEvents: "none"`) until grabbed. `dragListener={false}` means it
   never starts its own drag from its own pointerdown — only a `.start(e)`
   call does. The pile icon in the drawer (a totally different DOM
   element/location, inside a clipped drawer panel) calls
   `foodDragControls.start(e)` on its own `onPointerDown`, handing the
   *already-in-progress* pointer session to the floating element. This is
   the officially-supported framer-motion pattern for "start a drag from a
   different element than the draggable one" — an earlier round distrusted
   this pattern (`dragControls.start()` "never reliably worked") but that
   distrust was actually the eager-bailout bug below; the pattern itself is
   solid.
2. **onDragEnd never fires for a zero-movement press+release.**
   Confirmed via live testing: `dragControls.start()` does NOT bypass
   framer-motion's minimum-movement threshold for firing `onDragEnd` — a
   plain click (pointerdown, no pointermove, pointerup) leaves the sequence
   permanently stuck in `"held"`, which cascades into `petBusy=true`
   forever (the "everything's dead" lockup). **Fix: attach your own native
   `window.addEventListener("pointerup", ...)` SYNCHRONOUSLY inside the
   grab handler** (not in a `useEffect` — a `useEffect`-based listener can
   lose the race against a very fast click completing before the effect
   commits; this was a real, separately-fixed bug in an earlier round) as
   the release trigger of record. Use a ref flag (`foodReleasedRef`) so
   whichever fires first — the native listener or framer's `onDragEnd` —
   wins and the other is a no-op:
   ```tsx
   const onNativeUp = () => {
     if (foodReleasedRef.current) return;
     foodReleasedRef.current = true;
     window.removeEventListener("pointerup", onNativeUp);
     throwFoodRef.current(foodVelRef.current.vx, foodVelRef.current.vy);
   };
   window.addEventListener("pointerup", onNativeUp);
   ```
   Cancel paths (right-click while still `"held"`) must also set the
   released-guard and remove the listener, or a late pointerup could still
   fire a throw after cancellation.
3. **Velocity tracking is manual**, mirroring the pet's own drag-throw in
   `usePetMovement.ts` (not framer's `PanInfo.velocity`, for consistency
   with the one drag gesture in this codebase that's never been reported
   broken): track `{vx, vy, lastX, lastY, lastT}` in a ref, updated on every
   `onDrag` call using `performance.now()` deltas.
4. **A near-zero release velocity (`speed < 60`) falls back to a random
   nearby auto-toss** rather than requiring a real flick every time — keeps
   "just click it" working as a lighter-weight action.

## Poop cleanup (Jul 2026 plan Phase 0)

Post-hatch only — `shouldSpawnPoop(isEgg, onScreenCount)` in pet-core's
`poop.ts` gates on `isEgg` and an on-screen cap (numbers in `POOP_RULES`,
tunable placeholders). Flow: `throwFood`'s eat step calls
`schedulePoopSpawn()` → random delay → pet does a transient wiggle
(`petPoopWiggling`, reuses `egg-anim-wiggle`) → poop `motion.div` slides/
fades in just below the pet. The poop uses NATIVE framer drag (cursor stays
over the data-interactive element the whole drag, so no clickable-override
needed), but the DROP trigger of record is a native window `pointerup`
attached synchronously in its `onPointerDown` — framer's `onDragEnd` proved
unreliable again (same class as the feed/ball findings); `dropPoop(id,x,y)`
is id-guarded so the native trigger and a late `onDragEnd` can't
double-clean. Drop hit-test is the Kitchen panel's `[data-trashcan]` rect —
the SAME rect is also polled continuously during `onDrag` (not just on
release) via `isOverTrash()`, feeding a `poopOverTrash` boolean up to
SideDock as the `poopHoverTrash` prop so the trash can itself enlarges
(framer spring scale on the 🗑️ emoji) and glows while a poop is dragged
directly over it — makes the correct drop target obvious before release.
The poop's `motion.div` z-index is 25500 (ABOVE the Kitchen drawer's own
25000) — it was 15000 until Jul 2026, which put the dragged poop visually
BEHIND the open Kitchen drawer even though the drop logic worked fine; if
you ever bump SideDock's panel z-indices, re-check this one stays higher.
Reward: `game.cleanPoop()` — small happiness + care points via the normal
careAction path, increments the cloud-synced `poopCleanedCount` counter
(full petRow/migration plumbing, mirrors feed_count). Uncleaned poops are
session-only; they clear if the pet regresses to an egg.

## Idle liveliness — framer-motion breathing + gestures (Jul 2026)

Idle breathing is NO LONGER the `pet-anim-idle-breathe` CSS class on
bodyClass (the class still exists in petAnimations.css — the chess board's
pet-kings use it). GameView drives `breatheScaleX/breatheScaleY/
gestureRotate` motion values on a DEDICATED wrapper node nested inside the
display-scale wrapper, so they can never fight bodyClass's CSS keyframes or
the scale spring. A scheduler fires a random one-off gesture every ~6–20s
(blink via the existing asset swap, quick head-shake, slow look-around
tilt). GUARD RAIL (do not remove): the effect's cleanup stops every
animation AND resets all three motion values to rest the instant
`idleBreathing` flips false — a lingering inline transform would silently
override the walk/eat/happy CSS states.

## Send Home + pet z-order (late Jul 2026)

- **Send Home** (quiet-time feature): the shared `enterNest(speedPxPerFrame?)`
  helper is the single source of truth for "walk the pet/egg onto
  `[data-homeslot]` and tuck it in" — it looks up the slot rect, forces
  `movementMode: "static"`, sets `sentHome`, `movement.walkTo()`s there,
  and — if Send Home wasn't cancelled meanwhile (`sentHomeRef` check) —
  flips `petNested` true on arrival. TWO entry points share it:
  1. Radial 🏠 action (`sendHome`): opens the dock, FORCES it onto the Home
     tab (`ribbon.setActivePanel(null)` — the slot only exists in Home
     content; this is what fixed "Send Home did nothing while viewing
     Quests"), waits ~500ms for the panel slide-in, then calls
     `enterNest()` at the normal walk speed.
  2. **Drag-and-drop onto the slot** (`petDragHandlers.onDragEnd`): if the
     pet/egg is released within `NEST_DROP_RADIUS` (90px, center-to-center)
     of the slot, calls `enterNest(18)` (a quick snap, skipping the normal
     glide-settle) instead of `movement.dragHandlers.onDragEnd()`. This is
     the ONLY way to send an EGG home (eggs have no radial action — the
     egg's `radialActions` branch is just `canHatch ? [Evolve!] : []`) and
     a second entry point for a hatched pet. Requires the Home panel
     already visible (same precondition as the trash-can poop-drop
     hit-test) — dragging toward a closed dock just falls through to the
     ordinary glide. **Known easily-tripped test gotcha, not a real bug**:
     starting a SECOND drag while a `walkTo` from a first drop is still in
     flight cancels `sentHome` (via `onDragStart`) without stopping the
     walk's rAF loop, so the pet can end up parked exactly on the slot
     without ever actually nesting — don't interleave test actions with an
     in-flight drop-to-nest walk.
  3. **Drop-zone hover highlight** (Jul 2026 round 4, mirrors the trash
     can's `poopHoverTrash`): `petOverNest` (GameView state) drives
     SideDock's `petHoverNest` prop, enlarging/glowing the nest slot (scale
     1.35, solid green ring + inset glow) while the pet/egg is dragged
     directly over it, same as the trash can already did for poop. Driven
     by `useMotionValueEvent(movement.x/y, "change", cb)` gated by an
     `isDraggingRef` (true between `onDragStart`/`onDragEnd`) — **not** a
     custom `onDrag` handler and **not** an `requestAnimationFrame` poll.
     Both alternatives were tried and both failed in the browser-preview-
     mock pane specifically because that pane's tab is permanently
     `document.hidden`/unfocused, which fully suspends
     `requestAnimationFrame` (confirmed: a bare rAF loop ticks zero times
     over 2 real seconds there) — see the quests-testing skill's expanded
     pane-limitations section for the full writeup. `useMotionValueEvent`
     works there (and everywhere else) because `MotionValue.set()` notifies
     "change" subscribers synchronously, independent of the frame
     scheduler. **If you ever need to react to the pet's position DURING a
     drag again, reach for `useMotionValueEvent`, not `onDrag`/rAF** — it's
     also simpler and doesn't need its own start/stop plumbing.
  4. **Egg sprite in the nest**: `CAT_SPRITES[0]` (`petSprites.ts`) was
     added specifically for this — stage 0 (egg) previously had no entry,
     so `NestedPetSprite` fell back to a plain 🐱 emoji even when an EGG was
     nested. This is intentionally the ONLY caller that ever asks for stage
     0 art: `spriteFor()` is also called from every online/remote context
     (Chess, RPS, Toss, RemotePets), but eggs can never go online (product
     rule, see the pet-game-online skill), so those call sites are
     unaffected by this addition.
  Once nested: the ROAMING PET HIDES (display-scale wrapper animates
  scale→0 + opacity→0, stays hidden even with menus closed), and —
  critically — **the pet's outer container gets `pointerEvents: "none"`**
  (not just the inner sprite wrapper). Without that, the container's real
  screen position is the nest slot (inside the Home panel), and even fully
  invisible it stayed hit-testable at a HIGHER z-index than the dock
  (Part G), silently swallowing clicks meant for the ribbon tabs or
  whichever panel sat under it. Two toasts living inside the same
  container (`update_ready`, the friend/room/chess notification bubble)
  explicitly re-declare `pointerEvents: "auto"` so they stay usable
  regardless. The slot shows the pet's own idle asset (`NestedPetSprite`,
  breathe class) instead of the 🪺 placeholder — for an EGG specifically,
  `spriteFor("cat", 0)` returns null (no egg entry in `CAT_SPRITES`), so
  `NestedPetSprite` falls back to its plain-emoji branch (🐱), not an
  `<img>` — expected, not a bug. **Release paths**: clicking the slot
  (`onWakeFromNest`), OR grabbing food/ball while nested (`grabFood`/
  `grabBall` call `wakeFromNestRef.current()` unconditionally — no-ops via
  `petNestedRef` if not nested) — the exit plays concurrently with the
  throw, and the pet's own walkTo-to-eat at the end carries it clear of
  the nest. Cleaning (`canClean`) and, for an egg, warming (`canWarm`) are
  both explicitly BLOCKED while nested (`!petNested` in both) — doesn't
  make sense to scrub/warm something hidden. Free Roam/Follow Me/drag/
  "Come out" also clear both flags. `wakeFromNest` sets `petExitingNest`
  for ~650ms, adding `egg-anim-wiggle` to bodyClass on top of the scale-up
  spring already driven by `petNested` flipping false, so exiting reads as
  "growing back + wiggling out" rather than an instant pop. Nothing here
  sets petBusy — walkTo's 6s watchdog is the only timer, so no lockup
  class. `enterNest`/`wakeFromNest` are declared BEFORE `petDragHandlers`
  but `wakeFromNest` is declared AFTER grabFood/grabBall, so those call it
  via `wakeFromNestRef.current()` (forward-reference-by-ref, the file's
  existing `throwFoodRef` pattern) — never call it directly from an
  earlier-declared callback.

- **Cleaning/warming cursor z-index** (late Jul 2026 fix): the sponge
  cursor, its 🫧 bubbles, and the warm-lamp glow all render at
  `ABOVE_PET_Z` (25300) / `ABOVE_PET_Z - 1` — comfortably above the pet
  container's own max (25200, Part G). Before this fix they sat at the
  older 21000-ish tier, which was fine when the pet rendered BELOW the
  dock but left the sponge/lamp visually BEHIND the pet's body once Part G
  elevated the pet above 25000 — any new cursor/particle effect meant to
  render "on top of the pet" must use `ABOVE_PET_Z`, not a hand-picked
  z-index, or it'll silently regress the same way.
- **Pet z-order**: the pet container renders ABOVE the dock in normal play:
  `zIndex: burst ? 945 : inMinigame ? undefined : menuOpen ? 25200 : 25100`.
  Dock wrapper = 25000, dragged poop = 25500, food/ball = 26000, Chess
  panel 21500 / Toss arena 22000 (the pet correctly hides behind minigames
  via the `inMinigame` fallback). Known flagged tradeoff: where the pet
  visually overlaps an open dock panel, useHitTest's elementFromPoint
  resolves the PET — only mitigate if it proves a real nuisance.

## Radial menu outside-click collapse (Jul 2026)

While `menuOpen` is true, GameView holds the same capture-mode override
feed/scrub use (`setClickableOverride(true)` + whole-window clickable) and
renders a full-window transparent backdrop at zIndex 100 whose click closes
the menu; the pet container elevates to zIndex 500 so pet/radial clicks
never fall through. THE HANDOFF FOOTGUN: the menu effect's cleanup only
releases the override when `captureBusyRef` (feed/ball/scrub/warm phases)
says nothing else owns it — grabbing food closes the menu as part of
starting its OWN override, and an unconditional release there would kill
that drag mid-gesture. useHitTest's post-override resync then restores
normal click-through on the next tick.

## RULE: hover tooltips always use `<Tooltip>`, never a bare `title=` (Jul 2026)

`apps/desktop/src/game/Tooltip.tsx` is the ONLY way to show a hover hint
anywhere in this app — never add a native `title="..."` attribute to a DOM
element. The native browser/OS tooltip is slow, unstyled, and (in a
click-through overlay where most surfaces are hidden until you're already
hovering something interactive) easy to forget is even there; `<Tooltip
label="...">{element}</Tooltip>` gives every hint the same themed,
fast-fading look.

Why it's a `cloneElement` wrapper and not a wrapping `<span>`: several
existing tooltip targets are themselves `position: absolute` (the sync-dot/
update/chess/claimable badges anchored to the SideDock tab button, the
poop-drag hint, etc.) — introducing a new `position: relative` wrapper
around them would silently change what they're positioned relative to.
`Tooltip` instead clones the single child, attaches a ref +
onMouseEnter/onMouseLeave/onPointerDown (merged with any handlers the child
already had), and renders the floating label as a separate `position:
fixed` element positioned from the child's own `getBoundingClientRect()` —
zero layout impact. The label itself is always `pointerEvents: "none"`, so
it's invisible to `useHitTest`'s `document.elementFromPoint` poll and never
needs `data-interactive`. A falsy `label` (undefined/null/"") renders the
child with no tooltip at all, matching how `title={maybeUndefined}` used to
just no-op.

## Ballistic arc throw physics + squash-and-stretch

`throwArc()` (module-level helper, top of GameView.tsx) drives a genuine
parabola, not a spring/tween straight line:

```ts
x.set(fromX + (toX - fromX) * t);
y.set(fromY + (toY - fromY) * t - arcHeight * 4 * t * (1 - t)); // parabola
rotate.set(fromRotate + spinDegrees * t);
```

The progress driver (`animate(0, 1, { duration, ease: "linear", onUpdate })`)
must stay **linear** — the parabola formula itself (`4*t*(1-t)`, which peaks
at 1 when t=0.5 and is 0 at both ends) is what produces the
rise-then-fall/deceleration feel. Easing the progress on top of that
distorts the arc. `arcHeight`, `duration`, and `spinDegrees` all scale with
throw distance/speed so a hard flick arcs higher and spins more than a soft
one.

**Squash-and-stretch on landing:** food/ball each use separate `scaleX`/
`scaleY` motion values (NOT a single uniform `scale` — that can't produce a
squish). Sequence, synced to the Y-position bounce-hop animations via
`Promise.all`: instant squash on impact (`scaleX↑, scaleY↓`, e.g. 1.18/0.85)
→ stretch as the bounce carries it upward (`scaleX↓, scaleY↑`) → squash
again on the second touchdown → settle to `(1, 1)`. The ball's longer 2-hop
tail applies the same squash/stretch to each hop, tapering the magnitude
down with the diminishing bounce height. During mid-air flight, `throwArc`
applies a small *uniform* pop to both scaleX/scaleY (a "toward camera" size
bump at the apex) — only the landing bounce needs directional squish.

## The `useConsumables.ts` eager-bailout footgun — DO NOT REINTRODUCE

This was the actual root cause of a multi-session "feeding/ball just doesn't
work" bug that survived five-plus "fixes" to the *gesture* code before being
found. The original `takeFood`/`takeBall` computed their synchronous return
value by mutating a closure variable inside a `setState` updater function:

```ts
// BROKEN — do not write this pattern again anywhere in this codebase.
const takeFood = useCallback((slot: number): boolean => {
  let taken = false;
  setFoodRespawnAt((prev) => {
    if (prev[slot] > Date.now()) return prev;
    taken = true;
    return next;
  });
  return taken; // relies on the updater running SYNCHRONOUSLY — not guaranteed
}, []);
```

This only "works" via React's internal "eager bailout" optimization (an
implementation detail, not a public contract), and in this app (React 19 +
`StrictMode` + a competing `setInterval` tick in the same hook) it
**consistently returned `false` even though the state update genuinely
landed** — confirmed by reading `localStorage` directly and seeing the
correct future respawn timestamp while the function's return value lied.
Every caller checking `if (!consumables.takeFood(slot)) return;` bailed out
before ever starting the throw sequence, while the pile item visually faded
and started its respawn countdown anyway — exactly the reported symptom.

**Fix, now in place:** plain `useRef` mirrors (`foodRespawnAtRef`,
`ballOutRef`) read/written synchronously, completely independent of React's
scheduling:

```ts
const takeFood = useCallback((slot: number): boolean => {
  const prev = foodRespawnAtRef.current;
  if (prev[slot] > Date.now()) return false;
  const next = [...prev];
  next[slot] = Date.now() + FOOD_RESPAWN_MS;
  foodRespawnAtRef.current = next; // synchronous source of truth
  setFoodRespawnAt(next); // triggers the re-render
  return true;
}, []);
```

**If you ever need a synchronous return value from a state-changing
callback anywhere in this codebase, use this ref-mirror pattern. Never rely
on a `setState` updater's side effect being observable synchronously.**

## petBusy / feedPhase / ballPhase — the state machine that must never stick

`petBusy = cleaningMode || feedPhase !== "idle" || ballPhase !== "idle" ||
isEvolving`. Every other interaction (opening the radial menu, feeding,
washing, evolving) is gated on `!petBusy`. This means **any sequence that
sets `feedPhase`/`ballPhase` to a non-idle value MUST reach `"idle"` again
through a `finally` block, no exceptions** — a stuck phase doesn't just
break that one action, it locks the entire pet ("everything's dead"). Every
async sequence in this file (`throwFood`, `runBallFetch`, cleaning) follows
`try { ...sequence... } catch { dbg/log } finally { reset all state to idle,
reset clickableOverride, reset motion values }`. When adding a new async
gesture, copy this shape exactly.

`feedPhase: "idle" | "held" | "released" | "eating"`,
`ballPhase: "idle" | "held" | "playing"` — `"held"` is the drag-in-progress
state (added back when drag-throw was restored); don't remove it even if a
future redesign seems simpler without it, since cancel-while-holding depends
on distinguishing it from `"released"`/`"playing"`.

## Movement (`usePetMovement.ts`)

- **Wander**: random target every 4–12s via `animate()` springs
  (`stiffness: 45, damping: 16`), paused while `active` is false (menu open,
  petBusy, asleep, etc). Also gated off at the GameView call site when the
  **Stay** setting (`useGamePrefs().movementMode === "static"`) is on —
  wander and "Stay" are the same `active` flag, just one more AND'd
  condition (`prefs.movementMode === "free"`); "Stay" does NOT disable
  dragging, only the self-directed wander loop.
- **Follow Me** (added alongside Stay/Free-Roam, Jul 2026): a separate rAF
  chase loop inside the hook, gated by its own `following`/`followSpeed`
  options — mutually exclusive with wander (GameView passes `active: false`
  whenever `following` is true; never rely on both being on at once, the
  hook doesn't defend against that itself). Reads the cursor from
  **`window.overlay.onCursor`**, NOT a native `mousemove` listener — same
  reason as `useHitTest.ts` (native mousemove doesn't reliably reach this
  click-through overlay). Has a 140px dead zone (stops before reaching the
  literal cursor point) and three speed presets (`slow/normal/fast`, see
  `FOLLOW_SPEED` map) driven by `useGamePrefs().followSpeed`. Dragging the
  pet always wins: `dragActiveRef` pauses the chase loop during a drag and
  for 650ms after `onDragEnd` (mirrors the glide-then-resume-wander timing
  used elsewhere in this hook) so the two gestures don't fight over
  `x`/`y`. GameView owns the toggle state (`isFollowing`) and force-cancels
  it whenever the pet becomes non-interactive (sleeping/dead/egg/kicked) or
  the radial menu opens — the hook itself has no opinion on when following
  *should* be on, only how to chase once told to.
- **Drag-glide-throw** (the pet itself, not food/ball): `drag` prop directly
  on the pet's own `motion.div` (no cross-element handoff needed — this is
  the "native" framer-motion drag case). `dragMomentum={false}`; velocity is
  tracked manually in `onDrag` and used to compute a glide-spring target on
  `onDragEnd` (`GLIDE = 0.13` factor). This is the drag gesture that's
  *never* been reported broken — when in doubt about whether a new drag
  pattern will work reliably in this click-through overlay, mirror this one.
- **`walkTo(x, y)`**: imperative rAF-stepped walk used by feed/ball/evolve
  to make the pet approach a point and `await` arrival. Has a **6-second
  watchdog** that teleports to the target and resolves if the walk somehow
  never arrives — this exists specifically so a stuck walk can't deadlock a
  whole feed/ball sequence (and therefore `petBusy`) forever. Don't remove
  it; if you see a walk-related hang, the watchdog firing (a `console.warn`)
  tells you the hang is happening AT the walk step vs. before it.

## Display scale — the robust centering mechanism (Jul 2026)

Hatched pets render at 0.7 of the 128px cell (`PET_DISPLAY_SCALE` in
GameView.tsx), the idle egg at 0.5 (`EGG_IDLE_SIZE`). **NEVER shrink sprite
`<img>` width/height to scale a pet** — that was tried and it broke every
position tuned against the cell (menus, rain, panels). The mechanism: the
sprite always renders at the FULL cell size and a dedicated wrapper applies
`transform: scale()` with center origin. Transforms don't affect layout, so
the cell (movement math, drag hitboxes, PetEffects' `inset: 0` overlay,
panel anchors) never changes and the art stays dead-center at any scale.
The wrapper is its own node because bodyClass's CSS keyframe transforms
would otherwise fight it. Scale stays 1 through the entire egg/hatch
cutscene and springs to 0.7 only when `hatchCutsceneActive` clears (the
jump-out moment). `RemotePets.tsx` mirrors the same cell+transform approach
(`REMOTE_SIZE`/`REMOTE_DISPLAY_SCALE`) and derives its label/bubble/menu
offsets from the scaled visual's computed edges (`REMOTE_VISUAL_TOP/BOTTOM`).

## Egg warm mode (replaces the old hold-on-egg gesture, Jul 2026)

During the egg phase the SideDock kitchen hides food/ball and shows a 💡
lamp instead; clicking it enters `warmingMode` in GameView — same bounded-
modal shape as wash-scrub (`setClickableOverride(true)`, OS focus for
Escape, right-click/Esc/✕ exits, `warmingMode` is part of `petBusy`). The
cursor becomes a layered glow orb that swells while `warmHeld` (holding
left button over the egg's padded cell box) and turns red on
`isEggOverheating`. The hold runs the same `startWarmHold`/`stopWarmHold`
200ms `warmTick` loop the direct gesture used; `warmHeldRef` is the
synchronous source of truth (ref-mirror pattern, see the useConsumables
footgun). There is NO direct pointer-hold on the egg sprite anymore.
Related: eggs never sleep — they go "dormant" (see replayOfflineGap's egg
branch in pet-core decay.ts) and cannot die; 0 warmth just stalls hatch
progress.

## throwArc lives in throwPhysics.ts; Target Toss uses curlPhysics.ts

The ballistic parabola was extracted verbatim from GameView.tsx to
`apps/desktop/src/game/throwPhysics.ts`. Feed/ball import it from there —
don't re-inline or fork the formula. The Target Toss minigame does NOT use
it (as of Jul 2026): it slides a puck in a straight line with exponential
friction decay via `apps/desktop/src/game/curlPhysics.ts` (`slidePuck`/
`slideDistance`/`slideDuration`) — a deliberate separate mechanic, not a
fork, chosen so the drag-aim preview line IS the travel line.

## Food-cancel didn't return the piece (fixed Jul 2026)

`cancelBall` always called `consumables.returnBall()` when canceling a
held-but-never-thrown ball, but `cancelFeed`'s equivalent didn't exist —
`useConsumables.ts` had `takeFood(slot)` (starts the 5-min respawn timer)
with no counterpart to undo it. Right-click-cancelling a food grab mid-hold
left the pile slot stuck on the full 5-minute countdown even though the
piece was never thrown or eaten. Fixed by adding `returnFood(slot)`
(resets that slot's respawn timestamp to `0`, symmetric to `returnBall`)
and a `grabbedFoodSlotRef` in GameView.tsx (grabFood records which slot,
cancelFeed reads it back) — mirrors the ball path exactly. **If you add a
third grab-able consumable with its own "held" cancel path, give it the
same take/return pair; a `take*` that starts a timer/flag with no `return*`
counterpart is the bug shape to avoid.**

## Quick-reference gotcha list

- Never trust a `setState` updater's side-effect return value synchronously
  — use a ref mirror.
- Any new `setClickableOverride(true)`-using gesture needs the resync fix in
  `useHitTest.ts` to already be intact, or clicks will get stuck after it
  ends.
- `useEffect`-attached window listeners can lose a race against a very fast
  user gesture — attach synchronously inside the event handler that starts
  the gesture instead.
- `dragControls.start()` does not make `onDragEnd` fire for a truly
  zero-movement press+release — always pair it with a native `pointerup`
  fallback if the gesture must also work as "just a click."
- Any async sequence that sets a busy-flag-contributing state MUST reset it
  in a `finally`, including on the cancel path (which may skip the
  `finally` entirely if it returns before the async function was ever
  called — check `useConsumables.returnBall()`/similar side effects are
  ALSO replayed on the cancel-while-held path, not just in the sequence's
  own `finally`).
- Follow Me's cursor tracking MUST use `window.overlay.onCursor`, never a
  plain `window.addEventListener("mousemove", ...)` — same click-through
  overlay limitation as `useHitTest.ts`. A native listener will appear to
  work while clickable but silently stop updating the instant the window
  goes click-through again.
- Wander (`active`) and Follow Me (`following`) must never both be true at
  once — GameView enforces this by construction (`active` is ANDed with
  `!followingActive`), not the hook itself. If you add a third movement
  driver (another rAF loop touching `x`/`y`), gate it the same way at the
  call site rather than teaching the hook about every combination.
- Never add a bare `title="..."` for a hover hint — wrap the element in
  `<Tooltip label="...">` (`apps/desktop/src/game/Tooltip.tsx`) instead, app-wide, no exceptions.
