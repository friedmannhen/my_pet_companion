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
  moves locally (`rpsOutcome`). Entry: 🎮 on a remote pet's mini-menu. The
  pick/reveal UI is the full-screen `minigames/RockPaperScissors.tsx` modal
  (RoomBar keeps only the pre-game invite banner). Timing lives in
  `ActiveMinigame`: `startedAt` drives a 5s pick countdown
  (`RPS_PICK_TIMEOUT_MS`) — no pick in time cancels the game locally with a
  message naming who didn't pick (`cancelled`, no broadcast needed);
  `resolvedAt` drives a 3s reveal drumroll (`RPS_REVEAL_MS`) before the
  already-known outcome is shown, winner's pet does the `.pet-anim-happy`
  wiggle. GameView delays the celebratory pulse by `RPS_REVEAL_MS` to avoid
  spoiling the reveal.
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
- **Live aim preview** (`mg {kind:"aim"}`, late Jul 2026): while pulling
  back, the active thrower broadcasts the pull displacement as viewport
  fractions (`sendTossAim`, throttled ~90ms like `pos`; `clearTossAim` on
  release). Receivers hold it in `room.tossAim` — display-only (never in
  the reducer/event log, no seq guard; last-write-wins is correct for a
  preview) — and mirror the same `*0.35` displacement on the active
  player's puck sprite. Cleared on release, on any applied throw/skip for
  that user, and by a >800ms staleness sweep in housekeeping.
- **AFK**: the active player's client self-skips at 30s
  (`TOSS_TURN_TIMEOUT_MS`, raised from 15s); if the active
  player LEFT the room (gone from presence), the first still-present
  participant in turn order is the skip authority (not the host — a
  departed host can't stall the game). Known low-probability race: a throw
  sent right at the 15s boundary vs. an authority skip can apply in
  different orders on different clients (both carry the same seq; first
  arrival wins per client) — needs presence flap + exact timing; noted, not
  yet fixed.
- **Physics sync (curling)**: the puck slides in a STRAIGHT line with
  exponential friction (`apps/desktop/src/game/curlPhysics.ts`, `slidePuck`
  — NOT throwPhysics' parabola). The thrower computes the stop point
  locally and broadcasts it (normalized 0..1 coords); every client replays
  the identical slide. An over-pulled stop point outside the viewport is a
  **MISS**: `TossThrowFx.distance` is `number | null`, null = miss (scores
  like a skip via the existing distance-null path in pet-core), the slide
  visual still plays, no landing marker. **Never `?? 0` the received
  distance** — that coerces a miss into a bullseye; the handler uses
  `typeof p.distance === "number" ? p.distance : null`.
- **Aiming UI does NOT reveal the landing spot** (product decision, Jul
  2026 — showing the exact stop point was "kinda cheating"). The drag only
  shows a short pull-direction line + a power bar (`MAX_PULL_PX`-normalized
  strength meter, turns red past 85%) — nothing about where the puck will
  actually land. `stopPointFor()` still computes the real stop point
  internally (needed to know in/out-of-bounds and the eventual distance),
  it's just never drawn.
- **The puck is the thrower's own pet sprite**, not a generic icon
  (`PuckSprite`, `spriteFor`/`emojiFor` from `petSprites.ts`, ~45px —
  `PUCK_SIZE`). Spin is a small tumble (`min(50, 10 + pullLen*0.08)`
  degrees), not a full spin — a spinning pet reads as broken, a spinning
  emoji doesn't. Landed pucks (`visibleMarkers`) render as the SAME small
  pet sprite sitting at its landing spot and STAY there (not a dot, not
  faded) for the rest of the round, wiped only when `markersKey` changes.
- **Scoring is golf-style, not "most rounds won"**: after 3 rounds, LOWEST
  total distance-from-center summed across every throw wins
  (`computeTotalDistances`/`totalDistanceLeaders` in pet-core's
  `targetToss.ts`). A miss charges `MISS_PENALTY_DISTANCE` (200) instead of
  a real distance — always worse than a bad-but-real throw, so skipping is
  never a good play. `computeStandings`/`roundWinners`/`standingsLeaders`
  (the OLD rounds-won tally) still exist and are unit-tested but are NOT
  what decides the winner anymore — don't reintroduce them into
  `applyTossEvent`'s win-check. Sudden-death tie-breaks still use single-
  throw lowest-wins (`resolveSuddenDeath`), unchanged.
- **Distance/marker/toast reveal is deferred to landing**: `game.lastFx`
  and `game.markers` (useRoom's scoring truth) update the INSTANT the event
  applies, before the slide animation even starts — showing them directly
  would spoil the result early. `TargetToss.tsx` keeps its own
  `revealedFx`/`visibleMarkers`, both set inside the `slidePuck(...).then()`
  completion callback, never bound directly to `game.lastFx`/`game.markers`.
- **Arena position is random per round but identical for every player that
  round** (seeded, Jul 2026): `TargetTossState.seed` is generated by the
  host in `startTossGame()` and broadcast once in the `mg-start` payload
  (not re-sent per round). Every client derives each round's target/
  launcher Y position from `arenaLayoutForTurn(seed, phase, round)` in
  pet-core (mulberry32-seeded, clamped to the 0.3–0.7 middle band so
  there's always room to pull back) — depends ONLY on (seed, phase, round),
  never on which player is throwing. **Layout must lag one throw behind the
  turn**: `currentTossTurn(core)` already points at the NEXT turn the
  instant an event applies, but the CURRENT throw's puck is still mid-
  flight using the OLD layout's coordinates — jumping the target/launcher
  early would visually teleport them out from under the sliding puck.
  `TargetToss.tsx` fixes this with its own `layoutRoundKey` state, only
  advanced inside the same slide-completion callback that reveals the
  result (via a `gameRef` mirror to read the freshest `core` at that async
  moment — the ref-mirror pattern, not the `game` closure, which is stale
  by the time the promise resolves).
- Each turn starts with a 3s all-players "get ready" banner
  (`TURN_READY_MS`) that blocks aiming; if participants still present drop
  to ≤1 mid-game, the game cancels locally with a lobbyNotice.
- The arena (`apps/desktop/src/game/minigames/TargetToss.tsx`) is a
  full-screen `data-interactive` overlay at zIndex 22000 (RoomBar's 23000
  stays above it); GameView mounts it when `room.tossGame` is set and owns
  the game-over history/RPC recording (`tossRecordedRef` one-shot guard).
  While any minigame is open (`room.tossGame || room.minigame`), GameView
  also sets `inMinigame` which disables the local pet's own drag handlers
  and radial-menu click — belt-and-suspenders on top of the overlay's
  z-index already blocking those clicks structurally.

## Forfeit ("Give up", Jul 2026 plan Phase 1)

Always decisive: the quitter takes the loss, the opponent gets the win — a
silent app-close never resolves anything.
- **RPS**: `room.forfeitMinigame()` broadcasts `minigame {kind:"forfeit"}`;
  BOTH clients set `outcome` (+ `forfeitedBy`), so the normal
  onMinigameResolved path records both results. `forfeitedBy` skips the
  reveal drumroll in the modal.
- **Target Toss**: `room.forfeitTossGame()` broadcasts `mg
  {kind:"forfeit"}` and closes the quitter's board; GameView's `onForfeit`
  prop records the quitter's own loss first (game-over effect can't — the
  game is null by then). Remaining clients add the quitter to
  `TargetTossState.forfeited`: their turns fast-skip (TOSS_DEPARTED_SKIP_MS
  only, and the skip authority must itself be non-forfeited), and when only
  ONE active participant remains, every remaining client derives
  `winners=[them]` locally (decisive win, NOT the "not enough players"
  cancel — that cancel path now explicitly skips forfeit-driven dwindling).
- Battle deliberately has no forfeit (resolves instantly anyway).

## Chess (Jul 2026 plan Phase 3) — persistent 1:1, DB + broadcast hybrid

Unlike every other minigame, chess games PERSIST (untimed — see the
pet-game-backend skill for the chess_games table/RPCs). Architecture: the
DB row is the resume-of-record; the `chess` broadcast event only keeps LIVE
clients in sync. All handlers live in join()'s buildAndSubscribe (topic
dedupe rule). Flow:
- Challenge: `chessChallenge(target)` (♟️ button on a remote pet's
  mini-menu) → targeted `invite`; acceptor sends `accept`; the CHALLENGER
  (white/player_a) inserts the chess_games row, then broadcasts `start
  {gameId}` — everyone fetches that row (spectators too), players auto-open
  the board. 23505 on insert = one-active-game-per-pair → friendly
  chessNotice.
- Moves: chess.js validates locally in `minigames/Chess.tsx`
  (auto-queen promotion); `sendChessMove` applies optimistically, updates
  the row (RLS allows: mover == current_turn), and broadcasts `move` with
  `ply` = history length after the move (applied only if it extends
  exactly; gaps self-heal on next DB load). Checkmate/draw ride the same
  update (`end` fields inline). **Move-history shape (late Jul 2026)**:
  entries are `{san, at}` objects (`ChessMoveEntry`) in the SAME
  `move_history` jsonb column — no migration; `chessRowToGame` normalizes
  old bare-SAN-string rows to `{san, at: null}` on read so the UI never
  handles a union. The board panel renders a numbered paired move list
  (auto-scrolled to newest) with compact relative times.
- Board panel UX: draggable by its header (dragControls handoff) and
  resizable via a ↘ corner grip driving a whole-panel `scale` (composed
  into framer's transform — never literal width/height); `{x, y, scale}`
  persist to localStorage `mpc_chess_panel_prefs` and clamp back on window
  resize. The Poke button locks for 3s after sending ("✅ Poke sent") so it
  can't spam the opponent's inbox.
- Endings: resign → `resign_chess_game` RPC + `end` broadcast; mutual
  cancel → `cancel-propose`/`cancel-accept` handshake then
  `cancel_chess_game` RPC (abandoned, NO score impact);
  `opponent_unreachable` unilateral cancel is UI-gated on opponent absent
  + no game activity for CHESS_UNREACHABLE_GRACE_MS (48h). Each PLAYER
  client fires `onChessResolved` exactly once per finished game
  (chessRecordedRef) → GameView records history + `record_minigame_result
  ('chess')`. A fully-offline player misses their record (accepted, same
  as notifications).
- Visibility: leaving the ROOM never resolves a game (teardown only clears
  local panel state); minimize collapses to a chip (never forfeits); a
  picker beside RoomBar lists all active games in the room
  (resume/spectate); SideDock shows a ♟ tab badge (my active games) and a
  per-group-card count (`useGroupChessCount`); leaving a GROUP with my
  active game warns first ("leave anyway" two-click).
- Poke: `chess_poke` notification kind (whitelisted in useNotifications,
  payload carries groupId + gameId); tapping the toast deep-links — joins
  that room if needed and opens that specific board.
- Kings render as the players' live pet sprites (own save for me, presence
  data for others — falls back to the classic glyph if the owner isn't in
  presence); per-viewer orientation is a pure render flip (own side at the
  bottom, spectators see White below).

## Personal notifications (`useNotifications.ts`, Jul 2026)

Realtime-only (deliberately NO DB persistence — a notification is missed if
the recipient's app is closed). Each signed-in client subscribes to its own
persistent `user-inbox:<userId>` channel; `sendTo(targetUserId, payload)`
opens a TRANSIENT channel on the TARGET's topic, sends once SUBSCRIBED,
then removes it (~1.5s later). Topics differ per user so the sender's
transient channel can never collide with its own inbox subscription (topic
dedupe footgun). `sendTo` auto-stamps `fromId: userId` onto every payload
(callers never pass it) — this is what lets a decline round-trip back to
the exact right person. Kinds: `friend_request`, `friend_accepted` (sent
from SideDock's Add/Accept buttons), `room_invite` (sent from the 🌐 Invite
button on a friend row, only visible while in a room),
`room_invite_declined` — a **control signal**, never shown as a toast/
inbox entry, exposed instead as `lastDecline: {fromId, groupId, at}` —
plus (Jul 2026) `chess_turn` — LOCAL-ONLY like update_ready: GameView
derives it from already-synced `room.chessGames` when a game's
`currentTurn` flips opponent→me (per-game last-seen ref so it fires exactly
once per transition, suppressed while that board is open unminimized) and
shows it via `notifications.setLocalToast(...)`, which reuses the normal
toast TTL/dismiss machinery without broadcasting anything — and
`chess_poke` (targeted, whitelisted inbound, deep-links on
tap) and `update_ready` — the latter is **local-only**: synthesized in
GameView from `appUpdate.updateState === "ready"`, never broadcast,
deliberately NOT in the inbound whitelist, no TTL auto-clear (explicit
"Later" dismisses; a ⬆ tab badge then persists until installed; "Update
now" calls installUpdate() right from the toast). UI:
a clickable "the pet tells you" bubble above the local pet (6s TTL, opens
the dock at friends/groups), plus a persistent Join/Dismiss banner for room
invites mounted NEXT TO RoomBar in GameView (RoomBar renders nothing
outside a room, and invites matter precisely then). Join uses the
already-known group when the recipient is a member, else
`groupsApi.join(inviteCode)` → `room.join`.

**Room-invite spam guard + mutual cancel (Jul 2026)**: GameView owns
`pendingRoomInvites: Record<friendId, sentAt>` — `inviteFriendToRoom()`
no-ops if that friend already has a live pending invite (<60s old), so
mashing the 🌐 Invite button can't spam duplicate invites. The pending
entry (and the friend row's "🌐 Invite" button swapping to disabled
"⏳ Invited…") clears three ways: (1) the invited friend's userId shows up
in `room.members` — they joined; (2) `notifications.lastDecline` fires
for that friend's id — they explicitly dismissed, or their OWN 60s
`ROOM_INVITE_TTL_MS` timeout auto-declined for them
(`useNotifications`'s `dismissRoomInvite`/TTL-expiry effect both send
`room_invite_declined` back to `roomInvite.fromId`); (3) a 60s backstop
timer on the inviter's own side (belt-and-suspenders in case a decline is
lost). The friend row also shows a third state — "✅ In your room" instead
of any invite control — once `roomMemberIds` (derived from `room.members`
in GameView, passed down to SideDock) already contains that friend.

Related UX invariants: typing/pasting a full 6-char invite code in "Join
with a code" auto-joins AND auto-enters the room (`submitJoinCode`,
ref-guarded against double-submit — all three submit paths funnel through
it); every "My groups" card is a `GroupRow` component with its own
always-on `useGroupPresenceCount` (one presence channel per listed group
while the groups tab is open) showing inline 🟢-per-player badges (cap 5,
then +N).

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
