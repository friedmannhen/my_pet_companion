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
- Sign-up has an optional **display name** field — set once, it's what
  shows on the leaderboard instead of your email prefix. You can also set
  or change it later from Settings.

## The pet overlay

The pet lives in a transparent, click-through, always-on-top window. It
never blocks clicks to whatever app you're using — only the pet itself and
its menus are interactive.

### Egg stage
- **Press and hold** the egg to warm it (a 🔥 flame appears while held).
  Holding pulses warmth and care points continuously.
- **Drag the egg** to move it anywhere on screen — a real drag (not just a
  hold) automatically cancels warming, so the two gestures don't fight.
- Eggs can be **washed** too — grab the sponge from the dock drawer (see
  "Washing" below).
- **Overheating**: once warmth hits 100%, the egg starts glowing red as a
  warning. Keep holding past a ~1-second grace window and you start
  **losing happiness and care points** instead of gaining anything — let go
  once it's full.
- Once care points reach the hatch threshold, tapping the egg **hatches
  it** — see "Evolving" below for what that looks like.

### Hatched pet (baby / adult / final)
- **Click the pet** to open the radial interaction menu — a ring of action
  buttons pops out around it:
  - 🤗 **Pet** — pets the pet, hearts float up. Has a **5-minute cooldown**:
    while recharging, a ring fills in around the button and a countdown
    badge (e.g. "3m", "45s") shows underneath it, so it's obvious when
    you'll be able to pet again.
  - 🌙 **Tuck in** — manual sleep toggle. This is *protected sleep*: stats
    stay frozen (floored, never dropping to zero) for up to 72 hours, so
    leaving the pet asleep over a weekend is safe.
  - ✨ **Evolve!** (appears only when ready) — see "Evolving" below.
- While the pet is **asleep**, the menu only shows **☀️ Wake** — every
  other action is hidden (not just disabled) until it wakes up.
- Feed, Wash and Ball aren't on this menu — the food pile, sponge, and
  ball all live in the dock drawer's **Kitchen & toy box** (see below).
- Click the pet again (or click elsewhere) to close the menu.
- Every care action floats **+X indicators** above the pet showing exactly
  what you earned (e.g. `+40 🍖`, `+5 ⭐`) — green for gains, red for
  losses (like overfeeding).
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
Open the dock drawer (see below) and find the pile of 🍖 in the
**Kitchen & toy box**. **Click a piece** — the drawer closes, the food
tosses itself to a random spot and tumbles as it lands, and the pet
**runs over and eats it**, all automatically. Each piece you take leaves a
gap in the pile that **regrows after 5 minutes** (the drawer shows a
countdown until the next piece). Cancel anytime while it's in flight with
**Esc** or **right-click**.

Feeding a pet whose hunger is already full is an **overfeed**: instead of
the usual gain, it costs happiness and care points (and the pet looks a bit
sick 🤢) — so there's a real reason not to spam it.

### Washing
Grab the 🧽 sponge from the drawer's Kitchen & toy box (click it) — your
cursor becomes a sponge, and light rain/water-drop effects appear over the
pet while you work. **Hold the left mouse button down and move the sponge
back and forth over the pet itself** to scrub — progress and the bubble
particles only happen while the sponge is actually over the pet, moving it
off just pauses everything without losing progress. A progress bar shows
how much scrubbing is left (a dirtier pet needs more scrubbing, up to ~10
seconds of real scrubbing motion). Stop moving (even with the button held)
and progress pauses — you have to keep the sponge moving. Cancel anytime
with **Esc**, **right-click**, or the **✕** button on the progress panel.

### Playing fetch
**Click the ⚾ in the drawer** — same as food, one click does the whole
thing: the ball tosses itself to a random spot, bounces, and the pet trots
over, grabs it with a little bounce, winds up, and throws it back at you
(a zoom-and-fade flourish, same beat as the old QA-hub widget). The ball's
slot in the drawer sits empty until the pet is done playing, then it
returns. Cancel anytime with **Esc** or **right-click**.

### Evolving
Tapping a ready egg, or clicking ✨ Evolve! on a hatched pet, starts a
**10-second charge-up** (the pet glows/pulses — a stand-in until real
evolution art exists) before the new stage is revealed with a star burst.
The pet can't be interacted with again until the charge-up finishes.

### Death
If a pet's care need (hunger, or warmth for an egg) hits zero, it dies.
Click it to see a "didn't make it" message with a **Start over** button.

## The dock (house tab + drawer)

A house-icon tab sits fused to one screen edge — it's the handle of the
game's drawer.
- **Click the tab** to slide the drawer out (and again to close it — or
  use the **✕** in the drawer's header). The tab and drawer are one
  connected piece: the tab rides along with the drawer as it opens.
- **Drag the tab up/down** to set its height on the edge (vertical only —
  which edge it lives on is a Settings choice). Height is remembered
  between launches.
- The drawer's **🏠 home view** shows the Kitchen & toy box (food pile,
  ball, sponge), all stat bars with their icons (🍖/🔥, 🧼, ❤️) plus a
  **gold ⭐ care-points bar** tracking progress to the next evolution,
  age/stage info, and lifetime care history. It's part of the pet overlay
  itself (not a separate window), so it updates the instant you interact
  with the pet.
- The **⚙ Settings view** (gear button in the drawer header) has: dock
  side (left/right edge), a **🔊 sound toggle** (feeding noms, wash
  splashes, pet squeaks, evolution fanfares — all synthesized, no audio
  files), **renaming your pet** (confirms with a green "✓ Renamed!" once
  saved), your **display name** for the leaderboard (same confirmation),
  **⚠️ Take over** (only shown if your account is active on another device
  — click to make *this* the live session), **Sign out**, and **Quit**. A
  red sync-error message appears here too if something's wrong with cloud
  sync.
- A colored dot on the tab shows cloud-sync status at a glance (green =
  synced, yellow = syncing, gray = offline, red = error). A red number
  badge on the tab means you have unclaimed quest/achievement rewards.

## Quests (📜 in the drawer header)

- **Daily quests** (reset every day at the daily cutoff; unclaimed rewards
  are lost at reset):
  - **Balanced Care** — 3 qualified feeds + 3 washes + 3 pets (same-type
    actions must be at least 1 hour apart to count).
  - **Focus Session** — keep the pet awake with ALL stats at 70+ for 120
    minutes total.
  - **Clean Run** — no overfeeds from midnight until the daily cutoff.
- **Weekly quests** — all designed around **any 4 good days out of the
  week**, so skipping a weekend never locks you out:
  - **Careful Feeder** — feed on 4 different days with zero overfeeds all
    week.
  - **Play Week** — 2+ ball throws on 4 different days.
  - **Hunger / Cleanliness / Happiness Guardian** — keep that stat at 50+
    for 60 awake minutes on 4 different days.
- Completed quests turn green with a **Claim** button — claiming awards
  bonus ⭐ care points on the spot.

## Achievements (🏆 in the drawer header)

Long-term lifetime goals (total feeds, washes, pets, ball throws, hatches,
evolutions, quests completed…). Reaching a tier makes it **claimable**;
claiming applies a **permanent % bonus** to the care points earned by that
category of action (feeding / washing / play) — stack them up over time.

## Leaderboard & hall of fame (🌍 in the drawer header)

- **Leaderboard** — the top pets across all players by care points (your
  row is highlighted). Updates when you open the view or hit ↻ Refresh.
- **Hall of fame** — permanent, first-come-only records (e.g. the first
  pet ever to reach its final form). Once claimed, a record keeps its
  owner's name forever.

## Groups & going online (👥 in the drawer header)

**Only hatched pets can go online — eggs stay home.**

- **Groups**: create a friend circle (you get a 6-character **invite code**
  to share), or join a friend's with their code. Everyone is also in the
  automatic **Global** group. You can leave any group except Global.
- **Enter a room** (🌐 button on a group): your pet appears on every
  member's desktop, and their pets appear on yours — walking around live,
  with name tags. A **room bar** shows up at the bottom of your screen.
- **Chat** (💬 in the room bar): messages appear as speech bubbles above
  the pets. **Emotes**: one-click reactions (👋 ❤️ 😂 😮 😢 🎉) burst above
  your pet on everyone's screen.
- **Click a friend's pet** to interact:
  - 🤗 **Pet it** — its owner sees hearts and their pet gains a little
    happiness (no care points, so it can't be farmed).
  - ⚔️ **Challenge it** — the owner gets an Accept/Decline banner. On
    accept, a **3-round battle** plays out identically on both screens:
    rounds are decided by pet stage + how well-cared-for each pet is, with
    enough luck that no fight is ever a guaranteed win. Winner gets
    **+10 happiness and +6 ⭐**, loser sheds a little happiness.
- **Leave** from the room bar or the Groups view. Chat is ephemeral —
  nothing is stored.

## Dev-only: admin panel

Visible only in development builds (never in a packaged release), a small
🛠️ wrench button sits in the bottom-left corner. It opens a panel with:
- One-click **presets** (fresh egg, ready-to-hatch, baby/adult/final,
  starving, filthy & sad, dead) so you don't have to grind for real.
- **+care points** and **set all stats to a value** buttons.
- **Time jump** buttons that simulate the app having been closed for 1/12/80
  hours, replaying decay so you can test offline catch-up and sleep-
  protection expiry without actually waiting — also clears the petting
  cooldown and the quest engine's 1h qualified-action gaps.
- **Cooldowns & items**: instantly clear all cooldowns, or refill the food
  pile/return the ball, without waiting or time-jumping.
- **Reset**: wipe just quests, just achievements, or just this account's
  hall-of-fame claims — or a confirm-gated **💥 Full reset** that does all
  of the above plus starts a fresh pet.

## Known gaps (things not built yet)

- Only the cat is playable (phoenix and the other four pet types have no
  sprite art yet — see PET_GAME_TRANSFORMATION_PLAN.md §14).
- No Google/Microsoft sign-in — email/password only.
- Room chat/emotes/battles need both players online at the same time —
  there's no offline inbox yet. Friend requests (the DB supports them) have
  no UI yet; groups + invite codes are the way to connect for now.
- Room channels are only as private as the group (hardening with Realtime
  authorization is a follow-up).
