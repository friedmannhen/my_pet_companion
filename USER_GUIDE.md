# My Pet Companion — User Guide

A living reference for how to actually play the current build. **Update this
file in the same commit/session as any change to controls or mechanics** —
it should never drift behind what's implemented.

## Getting started

- Launch the app (`pnpm dev:desktop` from the repo root, or the packaged
  build once that exists). A small sign-in card appears — the app is
  **online-only**: no pet exists or renders until you're signed in.
- **Sign up** with an email + password (min 6 chars) and confirm password.
  If email confirmation is enabled on the Supabase project you'll need to
  click the link in your inbox before signing in; otherwise you're signed
  in immediately.
- **Remember me on this device** (checked by default): keeps you signed in
  across app restarts. Uncheck it if you want a fresh sign-in every launch.
  Your last-used email is always remembered regardless, so you never have
  to retype it.
- Once signed in, your pet appears — a floating cat that roams your desktop.

## The pet overlay

The pet lives in a transparent, click-through, always-on-top window. It
never blocks clicks to whatever app you're using — only the pet itself and
its menus are interactive.

### Egg stage
- **Press and hold** the egg to warm it (a 🔥 flame appears while held).
  Holding pulses warmth and care points continuously.
- **Drag the egg** to move it anywhere on screen — a real drag (not just a
  hold) automatically cancels warming, so the two gestures don't fight.
- **Right-click the egg** to open a small menu with a 🧼 **Clean** action
  (same scrubbing mini-game as a hatched pet — see "Washing" below).
- Once care points reach the hatch threshold, tapping the egg **hatches
  it** — see "Evolving" below for what that looks like.

### Hatched pet (baby / adult / final)
- **Click the pet** to open the radial interaction menu — a ring of action
  buttons pops out around it:
  - 🧼 **Wash** — see "Washing" below.
  - 🤗 **Pet** — pets the pet, hearts float up. Has a **5-minute cooldown**
    (grayed out until it's up) so it can't be spammed for free happiness.
  - 🌙 **Tuck in** — manual sleep toggle. This is *protected sleep*: stats
    stay frozen (floored, never dropping to zero) for up to 72 hours, so
    leaving the pet asleep over a weekend is safe.
  - ✨ **Evolve!** (appears only when ready) — see "Evolving" below.
- While the pet is **asleep**, the menu only shows **☀️ Wake** — every
  other action is hidden (not just disabled) until it wakes up.
- Feed and Ball aren't on this menu anymore — see "Feeding" and "Playing
  fetch" below, both now live in the stats drawer's kitchen/toy box.
- Click the pet again (or click elsewhere) to close the menu.
- **Drag the pet** with the mouse to pick it up and move it — release to
  throw it, and it glides to a stop based on how fast you were moving it
  when you let go.
- Left alone, the pet wanders on its own: it picks a random spot, strolls
  over with a slight bounce, then pauses for several seconds before moving
  again. When it's just standing still it also breathes gently — a small
  idle wiggle instead of looking frozen.
- While the pet is mid-action (feeding, washing, fetching, or evolving) it
  deliberately **holds still and can't be dragged or clicked** — those
  gestures need the pet to stay put, and a stray click shouldn't reopen the
  menu mid-scrub.

### Feeding
Open the stats drawer (see below) and find the small pile of 🍖 in the
**Kitchen & toy box** section. **Click a piece to grab it** — the drawer
closes and the food appears in your hand at that spot. **Drag it wherever
you like and let go to throw it** — the same grab-drag-release gesture as
dragging the pet itself, including the same momentum-based glide when you
release. The food tumbles as it lands, and the pet **runs over and eats
it**.

Feeding a pet whose hunger is already full is an **overfeed**: instead of
the usual gain, it costs happiness and care points (and the pet looks a bit
sick 🤢) — so there's a real reason not to spam it.

### Washing
Click 🧼 Wash (or right-click the egg → Clean) to grab the sponge — your
cursor becomes a sponge, and light rain/water-drop effects appear over the
pet while you work. **Hold the left mouse button down and move the sponge
back and forth over the pet** to scrub. A progress bar shows how much
scrubbing is left (a dirtier pet needs more scrubbing, up to ~10 seconds of
real scrubbing motion). Bubbles pop off the pet while you're actively
scrubbing. Stop moving (even with the button held) and progress pauses —
you have to keep the sponge moving. Cancel anytime with **Esc**,
**right-click**, or the **✕** button on the progress panel.

### Playing fetch
Open the stats drawer and click the ⚾ in the **Kitchen & toy box**
section — this one plays itself out: the drawer closes, the ball bounces
onto the screen, the pet trots over and grabs it with a little bounce, then
winds up and throws it back at you (a zoom-and-fade flourish), same beat as
the old QA-hub widget's fetch animation.

### Evolving
Tapping a ready egg, or clicking ✨ Evolve! on a hatched pet, starts a
**10-second charge-up** (the pet glows/pulses — a stand-in until real
evolution art exists) before the new stage is revealed with a star burst.
The pet can't be interacted with again until the charge-up finishes.

### Death
If a pet's care need (hunger, or warmth for an egg) hits zero, it dies.
Click it to see a "didn't make it" message with a **Start over** button.

## Control tab & stats drawer (screen edge)

A small tab docked to a screen edge, showing the house icon.
- **Click it** to slide out the full stats drawer directly from the same
  edge — no intermediate menu. The drawer shows the food/ball
  "Kitchen & toy box" (see "Feeding" / "Playing fetch" above), pet stats,
  care-point progress, age, lifetime action counts, and — at the bottom —
  account actions: **⚠️ Take over** (only shown if your account is already
  active on another device — click it to make *this* the live session),
  **Sign out**, and **Quit**. It's part of the pet overlay itself (not a
  separate window), so it updates the instant you interact with the pet.
  Click the tab again, or the **✕** in the drawer's header, to close it.
- **Drag the tab** to reposition it — drop it anywhere near either edge of
  the screen and it snaps to that edge at whatever height you dropped it
  (no separate side/height buttons). Your placement is remembered between
  launches. When the drawer is open, the tab rides along attached to its
  outer edge, like a handle, instead of being draggable.
- A colored dot on the tab shows cloud-sync status at a glance (green =
  synced, yellow = syncing, gray = offline). If there's an actual sync
  error, a red message appears inside the drawer instead of just the dot.

## Dev-only: admin panel

Visible only in development builds (never in a packaged release), a small
🛠️ wrench button sits in the bottom-left corner. It opens a panel with:
- One-click **presets** (fresh egg, ready-to-hatch, baby/adult/final,
  starving, filthy & sad, dead) so you don't have to grind for real.
- **+care points** and **set all stats to a value** buttons.
- **Time jump** buttons that simulate the app having been closed for 1/12/80
  hours, replaying decay so you can test offline catch-up and sleep-
  protection expiry without actually waiting.

## Known gaps (things not built yet)

- Only the cat is playable (phoenix and the other four pet types have no
  sprite art yet — see PET_GAME_TRANSFORMATION_PLAN.md §14).
- No quests, achievements, or leaderboards in the stats window yet.
- No Google/Microsoft sign-in — email/password only.
- No friends, groups, or multiplayer of any kind yet (Phase 2 session
  leases exist so only one device can be "live" at a time, but there's
  nobody else to interact with yet).
