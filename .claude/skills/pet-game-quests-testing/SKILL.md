---
name: pet-game-quests-testing
description: >
  Two related domains for my_pet_companion: (1) the exact quest/achievement/
  care-point economy rules in packages/pet-core/src/{quests,questDefinitions,
  achievements,decay,rules}.ts — quest codes, reward points, thresholds,
  evolution boundaries, and the carePointsFloor/applyCarePointPenalty split;
  (2) the browser-preview-mock debugging technique for testing this
  Electron-overlay app's renderer logic in a plain browser tab via Claude
  Preview tools, which is how a multi-session "feeding/ball doesn't work" bug
  was finally found and fixed by direct observation instead of guessing. USE
  THIS SKILL when: tuning quest/achievement rewards or thresholds, adding a
  new quest or achievement tier, debugging why a quest isn't completing/
  claiming/expiring correctly, changing care-point gain/penalty math or
  evolution thresholds, OR whenever a bug in this repo needs to be
  *empirically observed* rather than reasoned about statically — especially
  after 2+ rounds of a "fix" not actually resolving a reported interaction
  bug (drag, click, animation-state, or anything Electron overlay clicks
  can't be tested by reading code alone).
---

# Quests/achievements/economy rules + empirical debugging technique

## Part 1: Quest & achievement economy (packages/pet-core/src)

All of this is pure, deterministic, unit-tested logic (`quests.test.ts`,
`decay.test.ts`) taking explicit `rules`/`calendar` params — no hidden
globals, no `Date.now()` baked in anywhere it matters. When changing
balance, edit `rules.ts`/`questDefinitions.ts`, not the logic in `quests.ts`.

### Daily quests (`questDefinitions.ts` → `DAILY_QUEST_DEFINITIONS`)
Reset at the daily cutoff (`workCalendar.ts`'s `hasPassedDailyCutoff`);
unclaimed-but-claimable quests expire with reward discarded (recorded in
`rewardHistory`).

| code | title | requirement | reward |
|---|---|---|---|
| `balancedCare` | Balanced Care | 3 qualified feeds + 3 washes + 3 pets; same-type qualified actions ≥1h apart (`qualifiedActionGapMs = 60*60_000`) | 4 |
| `focusSession` | Focus Session | alive, awake, ALL stats ≥70, for 120 eligible minutes (`focusMinutesRequired`) | 3 |
| `cleanRun` | Clean Run | zero overfeeds from midnight to the daily cutoff | 3 |

### Weekly quests — "4 good days out of 7" (`WEEKLY_QUEST_TARGET_DAYS = 4`)
Deliberately designed so a skipped weekend never locks a player out — every
weekly is satisfied by ANY 4 days, not consecutive ones.

| code | title | requirement | reward |
|---|---|---|---|
| `noOverfeedWeek` | Careful Feeder | feed on 4 distinct days, zero overfeeds all week | 12 |
| `dailyPlayWeek` | Play Week | 2+ ball throws on 4 distinct days | 10 |
| `hungerGuardian` | Hunger Guardian | hunger ≥50 for 60 awake minutes (`GUARDIAN_MINUTES_PER_DAY`) on 4 distinct days | 10 |
| `cleanlinessGuardian` | Cleanliness Guardian | same, cleanliness | 10 |
| `happinessGuardian` | Happiness Guardian | same, happiness | 10 |

`recordCareActionQuestProgress(prev, action, rules, date, calendar,
qualified)` — the `qualified` param must be `false` when an action was
"hollow" (stat already maxed, i.e. an overfeed) so it can't farm quest
progress; `usePetGame.ts`'s `feed()` passes `before < 100` as `qualified`.
`markOverfeedQuestFailure` fails BOTH today's `cleanRun` and this week's
`noOverfeedWeek` in one call — always call it on the overfeed branch, not
just apply the point penalty.

### Achievements (`achievements.ts`) — 19 codes, 3-tier categories
`feed{25,100,250}`, `wash{20,80,200}`, `pet{30,120,300}`,
`play{30,120,300}` (play = petting + ball throws combined),
`firstHatch`, `allPetsHatched`, `firstFinalEvolution`, `globalLevel{7,14}`,
`quests{10,30,60}`. Each tier's reward is a **permanent** `AchievementRewardType
{ category: "feed"|"wash"|"play", percent: 3|6|9 }` — a % bonus applied to
that category's care-point gains going forward (see `multRef.current.feed`
etc. in `usePetGame.ts`, sourced from `useAchievements.ts`). Once earned an
achievement sits `"claimable"` until the player claims it — claiming is what
applies the bonus, earning alone does not.

### Care-point economy (`rules.ts`, `decay.ts`)
- Evolution thresholds (`DEFAULT_EVOLUTION_THRESHOLDS`): `[0, <hatch>, 1200,
  3500]` — stage 0→1 (hatch) uses `DEFAULT_EGG_HATCH_POINTS`, 1→2 (baby→adult)
  at 1200, 2→3 (adult→final) at 3500.
- `getCurrentCarePointBoundary` caps gains at the NEXT threshold so points
  can't overflow past a pending evolution — always pass gains through
  `clampCarePointsForProgress`.
- `carePointsFloor` is set to the threshold just crossed on every
  hatch/evolve (`hatchOrEvolve` in `usePetGame.ts`) — "points never decay
  back below the boundary just crossed." This floor is CORRECT for passive
  neglect decay (`replayOfflineGap`'s `penaltyRate` math also uses
  `Math.max(floor, ...)`), but **must NOT be applied to a deliberate misuse
  penalty** (overfeeding, egg overheating) — a penalty a floor silently
  absorbs is not a penalty. Use `applyCarePointPenalty(carePoints, amount)`
  (plain `Math.max(0, carePoints - amount)`, no floor) for those instead of
  `clampCarePointsForProgress`. This exact bug (overfeed penalty being
  no-op'd by the floor) was found and fixed once already — don't
  reintroduce it by routing a new penalty through the wrong helper.
- Overfeed penalty: `-5` care points + `-5` happiness. Egg overheat penalty
  (after a 1s grace window, `eggOverheat.graceMs`): `-0.5` care points/tick +
  `-1` happiness/tick.
- Poop cleanup (Jul 2026, `poop.ts`'s `POOP_RULES` — tunable placeholders):
  35% spawn chance per feed, 3 max on screen, cleaning grants `+3` happiness
  and `2` base care points (wash-category achievement bonus applies) via the
  normal careAction path — deliberately smaller than a full feed/wash/pet.
  Counter `poopCleanedCount` is cloud-synced for future achievement tiers
  (no achievement definition exists yet). Eggs never poop (gated in
  `shouldSpawnPoop`, unit-tested in poop.test.ts).

## Part 2: Empirical debugging via the browser-preview-mock technique

This app is an Electron click-through overlay — no available tool can
directly click inside the real `BrowserWindow`. After 5+ rounds of
"reason about the code, fix, ask the user to test, still broken" failed on
a feed/ball bug, running the EXACT SAME renderer code in a plain browser tab
(where Claude Preview tools CAN click, read console, inspect state) found
the real root cause in minutes. **Reach for this whenever a reported bug
survives a second attempted fix, or whenever you need to verify a
drag/click/animation-timing change actually behaves as intended rather than
just typechecking.**

### Setup (already in place — reuse it, don't recreate it)
- `apps/desktop/vite.browser.config.ts` — a standalone Vite config (root:
  `src`, same React plugin, port 5183) that runs ONLY the renderer, no
  Electron process at all.
- `apps/desktop/src/main.tsx` has a guard: if `window.overlay` is
  `undefined` (true only in a plain browser tab — real Electron always
  injects it via the preload's `contextBridge`), it installs a no-op mock
  (`setClickable`, `onCursor`, `setFocusable`, `quit` — matches
  `electron/preload.ts`'s `OverlayApi` exactly). This never affects the
  real Electron app.
- A `pet-browser-debug` launch config exists in `.claude/launch.json`
  **at the ERP_QA_HUB repo root, not my_pet_companion's** — Claude Preview's
  `preview_start` resolves `.claude/launch.json` relative to the SESSION's
  primary working directory, which may be a different repo than the one
  you're debugging. If `preview_start` runs the wrong project's `dev`
  script, add/fix the launch config in the *primary* working directory's
  `.claude/launch.json`, using a `cmd /c cd /d <path> && pnpm exec vite
  --config vite.browser.config.ts` runtimeExecutable to reach into
  my_pet_companion from elsewhere.

### Workflow
1. `preview_start` the `pet-browser-debug` config, `preview_snapshot` to
   confirm it loaded (you'll land on the sign-in card — this app is
   online-only, no pet renders until signed in).
2. Sign up a throwaway test account (`preview_fill` + `preview_click` /
   `preview_eval`-driven `.click()` — the accessibility snapshot's button
   list is reliable for finding the right one, `document.querySelectorAll`
   in `preview_eval` is faster once you know the DOM shape).
3. Open the dev-only 🛠️ admin panel (`import.meta.env.DEV` gate, same as
   real dev builds) to skip grinding: presets like "Adult" instantly hatch
   past the egg stage, "Refill pile" resets food/ball for repeat testing.
   **The admin toggle button and preset buttons need a real DOM
   re-render between clicks** — chain them with `await new Promise(r =>
   setTimeout(r, 100))` between opens/clicks/closes in the same
   `preview_eval`, or the second click fires before the panel is even
   open.
4. **Drive real gestures with synthetic `PointerEvent`s dispatched via
   `preview_eval`**, not `preview_click` (which can't simulate a drag).
   `dragControls.start()`-based drag gestures (see the pet-game-mechanics
   skill) need `pointerdown` on the origin element, several `pointermove`s
   on `window` with real `await setTimeout` gaps between them (framer-motion
   computes velocity from real elapsed time — zero-delay synchronous
   dispatches all collapse to `dt≈0` and velocity math breaks), then
   `pointerup` on `window`. Give each synthetic gesture its own
   `pointerId` if running several in sequence.
5. **To verify an animation is doing what you think, sample
   `getComputedStyle(el).transform` over time**, not just a single
   screenshot — this is how the ballistic-arc throw physics and the
   squash-and-stretch landing bounce were empirically confirmed (parabola:
   sampled Y values rose then fell; squash: `matrix(a,b,c,d,...)` values
   diverged from pure-rotation `a=d, b=-c` during the bounce, then returned
   to pure rotation once settled).
6. Read `console.log`/`console.error` via `preview_console_logs` liberally
   — the app has a DEV-only on-screen debug HUD (`dbg()` calls in
   `GameView.tsx`, prefixed `[game]`) specifically for this kind of tracing.
7. **A single `preview_eval` call's console output may appear duplicated
   6×** — this reflects multiple live tab/HMR connections to the same dev
   server, not 6 real user actions. Don't mistake this for a genuine
   duplicate-firing bug; check whether an action is ACTUALLY happening
   multiple times by looking for state-level evidence (e.g. `localStorage`
   values, or whether a sequence's `finally` block ran more than once), not
   just log-line counts.
8. When done, `preview_stop` the server — it's a debugging-only setup, not
   part of the shipped app.

### Preview-pane environment limits discovered Jul 2026 (work around, don't chase)

Found while verifying the nested-drawer overhaul; all confirmed against the
UNMODIFIED baseline too, so none of these are app bugs:

- **framer-motion `onTap` never fires from preview-tool clicks** (both
  ref-based `computer` clicks and synthetic PointerEvent sequences). Use
  the DEV-only `window.__mpc` hook GameView installs (`toggleDock()`,
  `toggleMenu()`, `spawnPoop(x?, y?)`) to drive that state instead. Plain
  React `onClick` buttons work fine with any click style — and since the
  multi-ribbon redesign the dock's 9 ribbon tabs ARE plain onClick buttons,
  so the dock can also be driven by clicking them directly.
- **Declarative animate-PROP animations are frozen at their `initial`
  values in this pane** (drawer slide, panel fade-ins, RadialMenu pop —
  all stuck at opacity 0 / initial x), while imperative `animate()` calls,
  `useSpring`, and drag physics all run normally. Consequence 1: check
  STATE-level evidence (element mounted, localStorage, rects), never
  "is it visible". Consequence 2: `AnimatePresence` exits never complete,
  so "closed" panels stay in the DOM — check the driving state, not
  innerText. In the real Electron app these animate fine.
- **`document.body.innerText` includes off-screen/transformed content and
  uppercases `text-transform: uppercase` headings** — match
  case-insensitively and don't treat "text present" as "visible".
- **Synthetic drags process at the pane's throttled rAF rate** — space the
  pointermoves out (~100ms+) and repeat the final position a few times
  before pointerup, or the release registers mid-path.
- **Root cause of the above, confirmed Jul 2026**: this pane's tab reports
  `document.hidden === true` and `document.hasFocus() === false` at all
  times (verified directly — `tabs_context`'s `isActive: true` doesn't
  change this), which makes Chrome fully suspend
  `requestAnimationFrame` — a raw rAF loop ticked **zero** times over 2 real
  seconds. This has two concrete, previously-misdiagnosed consequences:
  1. **`usePetMovement`'s own `walkTo` (rAF-driven step loop) never
     advances in this pane** — Send Home / feed / evolve sequences that
     call it will sit still until its 6s watchdog teleports the pet to the
     target (already documented above), not because the app is slow but
     because the step loop's `requestAnimationFrame(step)` is frozen.
  2. **framer-motion's drag-gesture `onDragEnd` callback never fires in
     this pane**, even though the raw pan mechanics (position tracking
     during `pointermove`) work perfectly and `onDragStart` fires reliably
     every time — position updates are applied synchronously per raw
     pointer event, but the drag's *end-of-gesture* completion is
     apparently scheduled through framer's internal frame loop, which is
     just as frozen as any other rAF consumer. **This was misdiagnosed once
     already** as "adding a custom `onDrag` handler kills the PanSession" —
     that was wrong; removing the custom `onDrag` entirely did not fix it,
     because the real cause is this pane's frozen rAF, not the handler.
     Practical fix for anything that needs to react to position *during* a
     drag (e.g. a drop-target hover highlight): use
     `useMotionValueEvent(motionValue, "change", cb)` instead of `onDrag` or
     an rAF poll — `MotionValue.set()` notifies "change" subscribers
     **synchronously**, not through the frame scheduler, so it fires
     correctly even with rAF fully suspended (confirmed live: the nest
     drop-zone's hover highlight lit up correctly mid-synthetic-drag using
     this approach). There is no equivalent workaround for `onDragEnd`
     itself — a drag-driven "drop" action can't be verified by a synthetic
     release in this pane; verify it indirectly instead (e.g. trigger the
     same underlying helper via a `walkTo`-based path, or trust the
     onDragEnd wiring by inspection once the shape matches an
     already-verified version) and note in the write-up that the
     drop-release path specifically relies on the real Electron window's
     normal (always-focused, un-throttled) rAF behavior.
- **Frozen entrance animations also freeze element GEOMETRY**: the radial
  menu's segments stay at their initial `scale(0)`, so their buttons
  measure 0×0 — never filter candidate buttons by rect size in this pane
  (match by textContent instead), and treat `walkTo`-style rAF walks as
  taking up to their full 6s watchdog before promises resolve.

### What this technique has already caught (don't re-derive from scratch)
- The `useConsumables.ts` eager-bailout bug (see pet-game-mechanics skill) —
  found by dispatching a click, seeing the log say "not ready," then
  checking `localStorage` directly and finding the state HAD changed
  correctly, proving the function's return value was lying.
- `framer-motion`'s `onDragEnd` never firing for a zero-movement
  press+release even via `dragControls.start()` — found by dispatching
  pointerdown+pointerup with no intervening pointermove and observing the
  sequence never progressed past `"held"`.
