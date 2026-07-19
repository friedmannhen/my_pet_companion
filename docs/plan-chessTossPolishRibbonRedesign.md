# Plan: Chess/Toss polish + Age fix + HUD scale + Multi-ribbon menu + Send Home

> **Fourth round (2026-07-19, "small fixes on the small fixes"): IMPLEMENTED
> + verified.** Two follow-ups to round 3's drag-drop-to-nest:
> 1. The nest slot now shows the real EGG sprite while a fresh egg is
>    nested, not the 🐱 emoji fallback — `petSprites.ts`'s `CAT_SPRITES` had
>    no stage-0 entry (only online-context callers used it before, and eggs
>    never go online, so the gap was invisible until Send Home/drag-to-nest
>    shipped). Verified live: triggering Send Home rendered
>    `<img src=".../egg/1.png">` inside `[data-homeslot]`.
> 2. Dragging the pet/egg over the nest slot now enlarges/glows it exactly
>    like the trash can already does for poop (`petOverNest` →
>    `petHoverNest`). Implementation detour worth recording: a custom
>    `onDrag` handler and, separately, an `requestAnimationFrame` poll were
>    both tried first and both appeared to break the feature — traced all
>    the way down to the browser-preview-mock pane's tab being permanently
>    `document.hidden`/unfocused, which fully suspends
>    `requestAnimationFrame` (confirmed independently: a bare rAF loop
>    ticks zero times over 2 real seconds there). The `onDrag`-breaks-
>    PanSession theory from the prior round was a misdiagnosis of the same
>    root cause. Fix: `useMotionValueEvent(movement.x/y, "change", cb)`,
>    which fires synchronously off `MotionValue.set()` and doesn't touch
>    the frame scheduler at all — verified live (the nest slot's border/
>    background/box-shadow visibly transitioned to the hover state
>    mid-synthetic-drag). Full detail in the pet-game-mechanics and
>    pet-game-quests-testing skills. Typecheck clean workspace-wide;
>    pet-core tests 96/96.

> **Feedback round (2026-07-19): IMPLEMENTED + verified in the browser
> mock.** Per the user's 5-point review of the first ribbon build:
> 1. Ribbon tooltips hang BESIDE the tabs (new Tooltip left/right
>    placements) — over the panel while open, interior-facing while
>    collapsed; verified on-screen and vertically centered.
> 2. Strict one-panel-at-a-time INCLUDING Home (`activePanel === null` =
>    Home content; a secondary panel's ✕ returns to Home).
> 3. Collapsed shows ONLY the 🏠 Home tab; the other 8 stagger in one by
>    one (~45ms steps) from the panel side when the menu opens.
> 4. The tab column is FUSED to the panel's inner edge (original
>    single-ribbon look): active tab shares the panel background, no
>    shadow seam, protrudes ~5px; column x/y are imperative motion values
>    so the first paint is correct, collapsed drag still persists the
>    anchor, auto-shift clamp keeps panel+column on-screen (verified:
>    anchor 500 → open at 188 on a 720px viewport).
> 5. Send Home ends with the pet ENTERING the nest: on walk arrival
>    `petNested` hides the roaming pet (scale+fade to 0, stays hidden with
>    menus closed — quiet time), the Home slot shows the pet's idle asset,
>    and CLICKING THE SLOT is the release path (verified end-to-end:
>    sprite in slot, "resting in the nest" status, click → released).
>
> **Second feedback round (2026-07-19): IMPLEMENTED + verified.** Real bugs
> found in the round-1 build, in the user's own words:
> 1. Send Home silently failed while viewing a non-Home tab (the nest slot
>    only exists in Home content) — fixed by forcing
>    `ribbon.setActivePanel(null)` inside `sendHome()`.
> 2. Grabbing food/ball required first clicking to "release" the nested
>    pet — actually a symptom of bug 3's same root cause (see below); now
>    grabbing food/ball while nested calls `wakeFromNest()` automatically
>    (no separate click needed) and the exit animation plays alongside the
>    throw.
> 3. The ribbon/Quests tab became hard/impossible to click while the pet
>    was nested — ROOT CAUSE: the pet's outer container sits at the nest
>    slot's screen position (inside the Home panel) at a z-index ABOVE the
>    dock (Part G), and though visually invisible it was still
>    hit-testable, silently intercepting clicks meant for the dock beneath
>    it. Fixed with `pointerEvents: "none"` on that container while
>    `petNested`; the update-toast and notification-bubble children
>    (siblings inside the same container) explicitly re-declare
>    `pointerEvents: "auto"` so they don't inherit the block. Also added a
>    🪺 badge on the Home tab so a nested pet stays visible/discoverable
>    even collapsed.
> 4. Secondary panels' "✕" close button removed (redundant with the tabs).
> 5. The active tab's ±5px "fused" position shift was removed — background/
>    opacity is now the ONLY active-tab indicator (the shift read as "losing
>    connection with the window").
> 6. Tooltip placement was backwards — simplified to
>    `isRight ? "left" : "right"`, always the interior side opposite the
>    dock's docked edge, independent of open/collapsed state.
> 7. Cleaning (sponge) is now explicitly blocked (`canClean` gates on
>    `!petNested`) while the pet is nested — feed/ball remain available and
>    auto-wake the pet on grab.
> 8. The nest exit reuses the existing scale spring (petNested→false makes
>    the display-scale wrapper animate back up) plus a ~650ms
>    `petExitingNest` pulse that layers the `egg-anim-wiggle` class on top,
>    so it reads as "growing back out with a wiggle" rather than an
>    instant pop — verified live (grabbing food while nested: pet unnests
>    within ~100ms of the grab, feed count still increments normally).
>
> **Third round (2026-07-19, "small general fixes"): IMPLEMENTED +
> verified.**
> 1. Sponge/bubbles/warm-lamp cursor now render at `ABOVE_PET_Z` (25300) —
>    they'd fallen behind the pet once Part G elevated it to 25100/25200.
>    Verified: sponge cursor z-index confirmed 25300 during an active scrub.
> 2. The active ribbon tab now grows `TAB_ACTIVE_GROW` (10px) wider instead
>    of just changing background — the column's flex alignment anchors the
>    panel-facing edge, so the extra width only protrudes toward the screen
>    interior, staying visually fused. Verified: active tab measured 56px,
>    inactive 46px, and swapped correctly switching tabs.
> 3. Dragging the pet OR an egg directly onto `[data-homeslot]` now sends
>    it home too (`petDragHandlers.onDragEnd` checks `NEST_DROP_RADIUS`,
>    90px) — a shared `enterNest()` helper (factored out of the old
>    `sendHome`) backs both the radial action and this drop path. This is
>    the ONLY way to nest an egg (no radial action exists for one).
>    Warming and cleaning are both blocked while nested (`canWarm`/
>    `canClean` gate on `!petNested`) with matching Tooltip copy. Verified
>    live end-to-end for both a hatched pet and a fresh egg (drag onto the
>    slot → "resting in the nest" status; lamp/sponge show `cursor:
>    default` + the correct blocked-tooltip text while nested).

> **Implementation status (2026-07-18): IMPLEMENTED (Parts A–G).** All code
> typechecks; pet-core tests pass (96). Browser-preview-mock verified: the
> 9-tab ribbon renders and toggles, Home merges the full Kitchen (poop→trash
> counter flow re-verified from its new home), the Pet Stats panel stacks 8px
> beneath Home and the auto-shift clamp keeps the whole stack on-screen from
> a low anchor (y=500 → openY=12 on a 720px viewport), age renders
> hour-aware, HUD scale applies `scale(1.3)` on the wrapper and persists,
> pet-size pref persists, pet z-index is 25100 above the dock, and Send Home
> walks the pet to the nest slot (movementMode forced static, slot
> highlights) with Free-Roam cancel verified.
> **Needs the usual two-account manual pass** (verification §2): poke
> cooldown + clearly-tappable poke toast, the chess_turn "your move" toast,
> chess panel drag/resize persistence, numbered/timestamped move list
> auto-scroll, and the live Toss pull-back preview + 30s countdown.
> **No DB migrations** — chess move timestamps ride the existing
> `move_history` jsonb (new rows store `{san, at}`; old bare-string rows
> normalize on read).
> Deliberate deviations, all cosmetic/robustness:
> - The chess panel resize scales the WHOLE panel via framer's composed
>   transform (not an inner wrapper) — scaling only the content left an
>   unscaled background box artifact.
> - Ribbon tabs are plain onClick buttons on one draggable column, with a
>   `draggingRef` guard suppressing clicks that end a drag.
> - The HUD wrapper divides layout math by the scale factor (`localVH`) so
>   Large/X-Large never push panels off the real screen.

## What shipped where

- **Part A (Chess)** — `Chess.tsx`: poke button shows "✅ Poke sent" +
  3s lockout; panel draggable by header (dragControls handoff) + ↘ grip
  resize (scale 0.7–1.5), `{x,y,scale}` persisted to
  `mpc_chess_panel_prefs`, clamped on window resize; numbered paired move
  list with per-move relative times, auto-scrolled to newest.
  `useRoom.ts`: `ChessMoveEntry {san, at}` shape (backward-compatible
  normalize in `chessRowToGame`), `sendChessMove` stamps `at` and includes
  it in the `move` broadcast. `useNotifications.ts`: `setLocalToast` helper
  + local-only `chess_turn` kind. `GameView.tsx`: per-game
  `chessTurnSeenRef` fires the "your move" toast exactly on the
  opponent→me transition (suppressed while that board is open); both chess
  toasts now read "🔗 Tap to jump back in" (underlined) and share the
  poke's deep-link branch.
- **Part B (Toss)** — `TOSS_TURN_TIMEOUT_MS` 15s→30s; new `mg
  {kind:"aim"}` live pull preview: `sendTossAim` (viewport-fraction deltas,
  ~90ms throttle) / `clearTossAim` on release; `room.tossAim` mirrors the
  active player's pull on their puck for everyone else; cleared on
  release/throw/skip/staleness (>800ms) and teardown.
- **Part C (Age)** — hour-aware: `Xh` under 24h, `Xd Yh` after; computed
  live from `birthDate` (no storage change); lives in the new Pet Stats
  panel.
- **Part D (Sizes)** — `useGamePrefs`: `hudScale` (sm/md/lg/xl →
  0.85/1/1.15/1.3) and `petScale` (100/90/80/70, shrink-only); SideDock
  scales its whole subtree via one wrapper transform; GameView multiplies
  the pet display scale by `petScale/100`; two new chip rows in Settings.
- **Part E (Multi-ribbon)** — 9-tab draggable column (Home + 8 secondary
  tabs, deliberately ungrouped); Home = header (nest slot, name, status) +
  4 stat bars + the ENTIRE Kitchen (food/ball/sponge/lamp/trash can) +
  version footer; one secondary panel stacked beneath Home; smart
  auto-shift keeps the expanded stack on-screen without rewriting the
  dragged anchor; `kitchenOpen` removed from `useRibbonPrefs`; new
  `petstats` panel holds Age/Stage/Hatched + care history + sleep info.
- **Part F (Send Home)** — radial 🏠 action: forces static mode, opens the
  dock, walks the pet onto the `[data-homeslot]` nest (placeholder 🪺 with
  dashed/solid ring; real art later). Cancels on pet drag, Free Roam,
  Follow Me, or the radial's "Come out".
- **Part G (Pet above dock)** — pet container z-index
  `burst 945 / inMinigame auto / menuOpen 25200 / else 25100`; dock 25000,
  poop 25500, food/ball 26000, minigames unchanged. The hit-test overlap
  tradeoff is flagged in code, not pre-solved.
