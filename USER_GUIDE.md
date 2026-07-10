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
- Once care points reach the hatch threshold, an ✨ sparkle appears above
  the egg and a **Hatch!** option becomes available in its menu.

### Hatched pet (baby / adult / final)
- **Click the pet** to open the radial interaction menu — a ring of action
  buttons pops out around it:
  - 🍖 **Feed** — see "Feeding" below.
  - 🧼 **Wash** — see "Washing" below.
  - 🤗 **Pet** — pets the pet, hearts float up.
  - ⚾ **Ball** — throws a ball for the pet, hearts float up.
  - 🌙/☀️ **Tuck in / Wake** — manual sleep toggle. Tucking in is
    *protected sleep*: stats stay frozen (floored, never dropping to zero)
    for up to 72 hours, so leaving the pet asleep over a weekend is safe.
  - ✨ **Evolve!** (appears only when ready) — advances to the next stage.
- Click the pet again (or click elsewhere) to close the menu.
- **Drag the pet** with the mouse to pick it up and move it — release to
  throw it, and it glides to a stop based on how fast you were moving it
  when you let go.
- Left alone, the pet wanders on its own: it picks a random spot, strolls
  over with a slight bounce, then pauses for several seconds before moving
  again.

### Feeding
Click 🍖 Feed — a piece of food appears near the pet and **follows your
cursor** (you're holding it). Move it wherever you like, then **click
anywhere on screen to throw it**. The food arcs through the air (direction
and distance depend on how you were moving the cursor when you clicked),
tumbles as it lands, and the pet **runs over and eats it**.

### Washing
Click 🧼 Wash to grab the sponge — your cursor becomes a sponge. **Hold the
left mouse button down and move the sponge back and forth over the pet** to
scrub. A progress bar shows how much scrubbing is left (a dirtier pet needs
more scrubbing, up to ~10 seconds of real scrubbing motion). Bubbles pop off
the pet while you're actively scrubbing. Stop moving (even with the button
held) and progress pauses — you have to keep the sponge moving. Press
**Esc** to cancel washing early without finishing.

### Death
If a pet's care need (hunger, or warmth for an egg) hits zero, it dies.
Click it to see a "didn't make it" message with a **Start over** button.

## Stats window

Click **📊 Stats** in the bottom-right control strip to open a separate
floating HUD panel (frameless, draggable by its top bar, closable with the
✕ button) showing your pet's full stats, care-point progress, age, and
lifetime action counts. It updates live the instant you interact with the
pet — no need to wait or reopen it.

## Control strip (bottom-right, always visible)

- A colored dot shows cloud-sync status (green = synced, yellow = syncing,
  red = error — hover for the error message).
- **⚠️ Take over** appears only if your account is already active on
  another device/session — click it to make *this* the live session.
- **📊 Stats** — opens the stats window.
- **Sign out** — returns to the sign-in card.
- **Quit** — closes the app.

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
