---
name: pet-game-online
description: >
  Exact realtime architecture for my_pet_companion's online rooms — Supabase
  Realtime channel/presence/broadcast shapes, the deterministic seed-shared
  battle protocol, groups/invite-code flow, and the RemotePets/RoomBar UI
  data flow, from apps/desktop/src/online/useRoom.ts and
  apps/desktop/src/game/useGroups.ts. Also covers the minigame layer: the
  1:1 Rock-Paper-Scissors handshake, the room-wide Target Toss lobby
  (invite/ready/start) and its event-log reducer turn system, and the
  minigame_scores persistence convention. USE THIS SKILL whenever the task
  touches: rooms, presence, joining/creating/leaving a group, remote pets
  rendering on screen, chat bubbles or emotes, the challenge/battle flow, the
  invite-code system, minigames (RPS, Target Toss, or adding a new one), or
  debugging why a friend's pet/position/chat/battle/game isn't showing up
  correctly for another player. Especially relevant right now since online
  testing (multiple real accounts in a shared room) is an active near-term
  priority for this project.
---

# Online / realtime architecture

No dedicated game server — everything routes through **Supabase Realtime**,
one channel per group, with clients computing shared outcomes (like battles)
independently from a shared seed rather than trusting a server authority.
Only hatched pets can go online (enforced client-side: `useRoom.ts`'s
`join()` no-ops if `isEgg`).

## Channel model

One channel per group: `` `pet-room:${group.id}` ``
(`supabase.channel(name, { config: { presence: { key: userId }, broadcast:
{ self: false } } })`). **Known hardening gap, not yet fixed**: channel
names embed the group's raw UUID and Realtime authorization isn't wired up
yet — anyone who can read the group row (or who's just told the id) could
theoretically subscribe. Fine for now, worth fixing before this goes beyond
friends-testing scale.

`broadcast: { self: false }` means your own broadcasts don't echo back to
you — `sendChat`/`sendEmote` apply their effect to local state immediately
(optimistic), THEN broadcast, rather than waiting for a round-trip.

**supabase-js gotcha (caused a real bug once — respect it in any new
channel code)**: `supabase.channel(topic)` dedupes by topic and returns the
EXISTING instance if one is registered, and channel removal deregisters by
TOPIC, not instance. So two features must never independently "own" the
same `pet-room:<id>` topic: one would hijack the other's already-subscribed
channel (`subscribe()` throws on a second call) or kill it on cleanup.
SideDock's `useGroupPresenceCount` (read-only live member count in the
groups menu) therefore piggybacks on an existing channel when one exists
(polls `presenceState()`, never subscribes/removes), and `useRoom.join()`
defensively frees the topic (awaits `removeChannel` of any stale observer)
before building its own channel.

## Presence

On `channel.on("presence", { event: "sync" }, ...)`, reads
`channel.presenceState<RoomMember>()` and rebuilds the `members` list
(excluding self). Presence payload, tracked once on `SUBSCRIBED`:
```ts
{ userId, name, petName: save.name, petType: save.petType, stage: save.evolutionStage }
```
If you need to show something new about a remote player at a glance
(without a broadcast round-trip), add it here — presence is the
"who's here and what do they currently look like" channel, broadcasts are
for events.

## Broadcast events

All sent via `channel.send({ type: "broadcast", event, payload })`.

| event | when | payload | notes |
|---|---|---|---|
| `pos` | every 200ms (`POS_SEND_MS`) if moved ≥0.004 (normalized 0..1 screen fraction) since last send | `{ from: userId, nx, ny }` | throttled + threshold-gated to avoid flooding the channel; received into `positions[userId]` |
| `chat` | `sendChat(text)` | `{ id: "<userId>-<Date.now()>", from, name, text (trunc 200 chars), at }` | applied optimistically local + broadcast; kept in `chatLog` (last 50) and as a 6s-TTL speech bubble in `bubbles[from]` |
| `emote` | `sendEmote(emoji)` | `{ from, emoji }` | 3s-TTL, stored in `emotes[from]` |
| `social-pet` | `sendSocialPet(targetUserId)` | `{ from, fromName, to }` | receiver's `onSocialPet(fromName)` callback fires only if `to === userId` — every client receives every broadcast, filtering by `to` is the app's job, not the channel's |
| `battle` | challenge/accept/decline handshake | `{ kind: "challenge"\|"accept"\|"decline", from, fromName, to, seed, snapshot? }` | see below |

Housekeeping runs every 1000ms: expires `bubbles` >6000ms old, `emotes`
>3000ms old, `incomingInvite` >30000ms old (`INVITE_TTL_MS`).

## Deterministic seed-shared battle — the pattern to reuse for any future PvP feature

No server ever computes a battle result. Both clients compute the SAME
result independently:

1. Challenger picks a random `seed` (`Math.floor(Math.random() *
   2_147_483_647)`), snapshots their own pet
   (`{ name, stage, hunger, cleanliness, happiness }`), sends `battle:
   {kind:"challenge", seed, snapshot, ...}`.
2. Target accepts: snapshots ITS OWN pet, sends `battle: {kind:"accept",
   seed: <same seed echoed back>, snapshot: <target's own>, ...}`, then
   immediately runs the battle locally as side `"b"`.
3. Challenger receives the `accept`, runs the battle locally as side
   `"a"` — using the SAME seed and the SAME two snapshots (its own
   remembered one + the target's, received in the accept payload) in the
   same `a`/`b` order.
4. `resolveBattle(seed, a, b)` in `packages/pet-core/src/battle.ts`: seeds
   a `mulberry32(seed)` PRNG, computes `battlePower(s) = stage*25 +
   happiness*0.4 + hunger*0.15 + cleanliness*0.15`, runs exactly 3 rounds
   (random move each round, `roll = power*0.5 + rng()*70`, ties replayed
   with further PRNG draws so the outcome is still fully determined by the
   seed), winner = best-of-3.
5. Because the PRNG is seeded and both clients run the exact same pure
   function with the exact same inputs, they arrive at bit-identical
   results with zero server round-trip and zero risk of desync — **this is
   the pattern to copy for any future feature needing "both players see
   the same outcome" without a server authority.** Don't be tempted to
   reduce payload size by NOT sending the full snapshot on both legs —
   both clients need the OTHER side's exact stats at challenge time, not
   whatever they might have changed to by the time accept arrives.
6. `declineInvite()` just sends `{kind:"decline", seed: inv.seed}` so the
   challenger can clear its pending-invite UI state.

`RoomBar.tsx` drives a timed reveal from the already-fully-known
`result.rounds` (`BATTLE_ROUND_MS`=1600ms/round, `BATTLE_VERDICT_MS`=1400ms
for the final banner) — the suspense is purely a client-side animation
pacing choice, the actual result was known instantly.

## Groups (`apps/desktop/src/game/useGroups.ts`)

- **List**: `group_memberships` joined through to `groups` for the current
  user; Global group always sorted first, then alphabetical.
- **Create**: `supabase.rpc("create_group", { group_name })` — see
  pet-game-backend skill for the RPC's server-side behavior (invite code
  generation, retry-on-collision).
- **Join**: `supabase.rpc("join_group", { code })` — idempotent, re-joining
  a group you're already in is a silent no-op, not an error.
- **Leave**: a direct `group_memberships` delete (the ONE membership write
  that doesn't need an RPC — RLS explicitly allows self-delete).
- **Invite codes**: 6 chars, uppercase, alphabet excludes `0/O/1/I` to stay
  readable when read aloud over voice chat — this is a real design
  constraint if you ever touch code generation, not an arbitrary choice.
- The **Global** group isn't created or joined by this hook at all — every
  account is auto-enrolled by the DB's signup trigger (see pet-game-backend
  skill); this hook only ever displays it.

## UI data flow (`RemotePets.tsx`, `RoomBar.tsx`)

Both are thin consumers of the single `RoomApi` object from `useRoom()` —
no other realtime plumbing lives in either component.

- **`RemotePets.tsx`**: renders `null` if no active group. For each
  `room.members` entry, looks up `room.positions[userId]` (skips entirely
  if no `pos` broadcast has arrived yet for that user — a freshly-joined
  member with laggy position updates just doesn't render until their first
  `pos` event lands), plus `room.bubbles`/`room.emotes` for that user.
  Sprite via `spriteFor(petType, stage)` from `petSprites.ts`, positioned
  at `nx * innerWidth, ny * innerHeight` (denormalizing the 0..1 fraction),
  animated with `useSpring` for smooth interpolation between position
  updates (since `pos` only arrives every 200ms, not every frame). Click →
  mini menu: 🤗 pet (`sendSocialPet` + local `sendEmote`) and ⚔️ challenge
  (disabled while a battle or outgoing invite is already pending — you
  can't double-challenge).
- **`RoomBar.tsx`**: bottom-center persistent bar while in a room — room
  name + connection-status color from `room.connected`, member count, 6
  quick-emote buttons, an expandable chat input, Leave button. Also owns
  rendering `incomingInvite`/`outgoingInviteTo` banners and the battle
  reveal sequence, calling `room.clearBattle()` once the timed reveal
  finishes.

## Minigames (Jul 2026) — RPS (1:1) and Target Toss (room-wide lobby)

**Product rule: minigames grant ZERO progression rewards** (no happiness, no
care points). Results are logged to local history and persisted per
`(user_id, game_code)` in `minigame_scores` via the atomic
`record_minigame_result(p_game_code, p_distance, p_won)` RPC — each
participant's OWN client calls it exactly once on game over (RLS blocks
writing anyone else's row). `RoomApi.selfId` exposes the local userId for UI
that needs "am I the host / is it my turn".

- **RPS** (`minigame` broadcast event, 1:1): invite/accept/decline/move
  handshake mirroring the battle pattern; both clients resolve the same two
  moves locally (`rpsOutcome`). Entry: 🎮 on a remote pet's mini-menu.
- **Target Toss** (`mg` broadcast event with a `kind` discriminator —
  functionally the plan's mg-invite/join/ready/roster/start/throw/skip/
  cancel): room-wide lobby, host-authoritative pre-start ONLY. The host
  rebroadcasts `roster` as ground truth on every join/ready (a join past the
  cap yields a roster without the joiner = "turned away"); `start` bakes the
  turn order. **After start there is NO host authority**: every client runs
  pet-core's pure reducer (`initTossGame`/`applyTossEvent`/`currentTossTurn`
  in `packages/pet-core/src/minigames/targetToss.ts`, fully unit-tested)
  over the same ordered throw/skip log — main phase (3 round-robin rounds,
  lowest distance wins a round) → sudden death among tied leaders (capped
  at 3 all-skip passes → co-win). Every event carries a `seq` guard
  (dropped unless it extends the local log exactly).
- **AFK**: the active player's client self-skips at 15s; if the active
  player LEFT the room (gone from presence), the first still-present
  participant in turn order is the skip authority (not the host — a
  departed host can't stall the game). Known low-probability race: a throw
  sent right at the 15s boundary vs. an authority skip can apply in
  different orders on different clients (both carry the same seq; first
  arrival wins per client) — needs presence flap + exact timing; noted, not
  yet fixed.
- **Physics sync**: the thrower computes its landing locally and broadcasts
  arc params (normalized 0..1 coords); every client (thrower included)
  replays the identical `throwArc()` from `apps/desktop/src/game/
  throwPhysics.ts` (extracted from GameView — feed/ball use the same
  export). Distances are normalized to the target radius so different
  monitor sizes compete fairly.
- The arena (`apps/desktop/src/game/minigames/TargetToss.tsx`) is a
  full-screen `data-interactive` overlay at zIndex 22000 (RoomBar's 23000
  stays above it); GameView mounts it when `room.tossGame` is set and owns
  the game-over history/RPC recording (`tossRecordedRef` one-shot guard).

## Debugging checklist for "X isn't showing up for the other player"

1. Are both clients actually subscribed to the SAME channel name (same
   `group.id`)? A stale `activeGroup` after a group switch is the most
   likely cause of silently talking past each other.
2. Is it a presence-driven field (should update on sync, near-instant) or a
   broadcast-driven one (throttled — `pos` specifically only sends every
   200ms AND only past the movement threshold, so brief/small movements
   near the threshold can look "laggy" but are working as designed)?
3. For anything battle-related: confirm BOTH clients' snapshots and the
   seed actually match — a stale `outgoingSnapshotRef` (challenger's own
   snapshot, remembered from challenge-time, not re-fetched at accept-time)
   is intentional (locks in the stats as they were at the moment of
   challenge) but can look like a bug if you're expecting live stats.
4. Use the pet-game-quests-testing skill's browser-preview-mock technique
   with TWO tabs (two different browser-mock sessions signed into two
   different test accounts) if you need to watch both sides of a realtime
   interaction at once without needing a second physical device.
