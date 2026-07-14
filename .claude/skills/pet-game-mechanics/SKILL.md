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
  "need to close and reopen to interact"), or before making ANY change to
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
  ("free"/"static" — the Stay/Free-Roam toggle), `followSpeed`
  ("slow"/"normal"/"fast", set from the Settings view, consumed by the
  Follow-Me loop).
- `SideDock.tsx` — the drawer UI: food pile spans, the ball span, the
  sponge. These are just trigger elements (`onPointerDown`) — the actual
  animated food/ball live in GameView as always-mounted, always-rendered
  `motion.div`s positioned purely via motion values.
- `overlay/clickableOverride.ts` + `overlay/useHitTest.ts` — the
  click-through toggling system. See "Click-through overlay model" below —
  this is the #1 source of "why isn't my new drag gesture receiving mouse
  events" bugs.

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
