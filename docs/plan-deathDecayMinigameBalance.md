# Plan: Death → Penalty Conversion + Minigame/Combat Anti-Farming

**Status (2026-07-20): Phases A–E implemented in code.** See "Implementation
notes" at the end of each phase below for what shipped, and the "As-built
deviations" section near the bottom for the handful of places the real
implementation differs from this plan's original sketch. **The new
migration (`supabase/migrations/20260720000000_minigame_matches.sql`) has
NOT been pushed yet** — needs `supabase db push` after review; RPS/Target
Toss score recording will fail (harmlessly — dbg-logged, game still plays)
until it's applied.

**Follow-up (2026-07-20, same day): Phase C's penalty model was rebalanced
again after live testing exposed it as still too harsh, and protected sleep
as too absolute.** See "Phase F" below — it fully supersedes Phase C items
12/13's `<20`-threshold/`STARVATION_PENALTY_MULTIPLIER` model, which is
removed. Everything else in Phase C (hard death removed, distressed visual
state, revive-on-load, restart moved to Settings) is unchanged.

Two problems, one plan. (1) Death is disproportionately harsh relative to how
gentle cleanliness/happiness decay already is by design — hunger is the only
real death vector, and the first 60 minutes of *any* absence are always
charged at the fast "awake" rate, so a pet at hunger 30 dies in as little as
~60 minutes of the app being closed. (2) The minigame-results pipeline can be
trivially gamed today: each client self-reports its own win/loss via
`record_minigame_result` with zero cross-check against the opponent, so
nothing stops a script (or two colluding accounts) from calling it repeatedly
without ever playing a real match.

Battle (online 1v1 pet fights) is a separate existing system and is
**intentionally out of scope for the mechanics rewrite** in Phase A/B below —
it's a placeholder for a future deeper battle system. Its current progression
reward (+10 happiness/+6 care points to the winner, −3 to the loser) is
flagged as **inconsistent** with the "combat/minigames give no progression,
only tracked record" policy this plan adopts, and should be aligned in a
follow-up once Battle itself gets real design attention — not bundled into
this pass.

## Current-state findings (grounding for this plan)

**Decay rates** (`packages/pet-core/src/rules.ts` → `DEFAULT_PET_RULES.decay`):

| Stat | Awake decay | Asleep decay |
|---|---|---|
| Hunger (or egg warmth) | 0.5/min | 1/15 ≈ 0.067/min |
| Cleanliness | 1.0/min | 0 (frozen) |
| Happiness | 0.5/min | 0 (frozen) |

Auto-sleep kicks in after 60 idle minutes (`rules.autoSleepMs`). Manual
"tuck-in" sleep freezes everything (floored at 10) for up to 72h
(`rules.sleep.protectedMaxMs`).

**Death** ([decay.ts](../packages/pet-core/src/decay.ts)'s `replayOfflineGap`):
`isAlive = careNeed > 0`, and `careNeed` is hunger only (warmth for an egg,
but eggs are hardcoded to never die — a fully cold egg just stalls). Cleanliness
and happiness never directly kill the pet, and because they freeze the
instant auto-sleep starts, a single absence starting from 100 can't even push
them below 20 (worst case ~40 cleanliness / ~70 happiness from one gap).
Hunger has no such ceiling — it keeps draining (slower) even while asleep.

Time-to-death from various starting hunger levels, closing the app
immediately (`idleAtClose = 0`, so the full 60-minute awake-rate window
applies before sleep decay takes over):

| Hunger at close | Time to 0 (death) |
|---|---|
| 100 | 60 min awake (→70) + 1050 min asleep ≈ **18.5 hours** |
| 50 | 60 min awake (→20) + 300 min asleep ≈ **6 hours** |
| 30 | 30/0.5 = **60 minutes** (still inside the awake window) |
| 20 | **40 minutes** |

**Neglect care-point penalty** (runs in parallel, independent of death):
```
penaltyRate = (hunger<20 ? 0.5 : 0) + (cleanliness<20 ? 0.3 : 0) + (happiness<20 ? 0.2 : 0)  // pts/min, max 1.0
carePoints = max(carePointsFloor, carePoints - penaltyRate * entireGapMinutes)
```
Bug/quirk: `penaltyRate` is computed from the **end-state** stats but
multiplied by the **entire gap's minutes**, not per-segment — a stat that was
fine for 90% of an absence and only dipped low right at the end is still
charged for the whole absence. Already bounded by `carePointsFloor` (can only
cost the current evolution stage's progress, never fall below the last
threshold crossed) — this makes the penalty-only outcome strictly gentler
than death, which additionally wipes `evolutionStage`,
`feedCount`/`washCount`/`petCount`/`throwBallCount` (unclaimed achievement-tier
progress) via `restart()` → `freshPetSave()`. Already-claimed achievement %
bonuses are safe either way (stored separately in the `achievements` table).

**Minigame trust gap** ([`supabase/migrations/20260713010000_minigame_scores.sql`](../supabase/migrations/20260713010000_minigame_scores.sql)):
`record_minigame_result(p_game_code, p_distance, p_won)` is `security invoker`
and only ever touches the caller's own row — nothing requires a real,
matching opponent submission. `games_won` is derived from a boolean `p_won`
with no separate tie/loss column.

## Steps

**Phase A — Server-authoritative minigame matches (the anti-farming core)**
1. New migration: `minigame_matches` (id, game_code, group_id,
   participant_ids[], status, winner_ids[]) + `minigame_match_submissions`
   (match_id, user_id, payload jsonb, sealed — a player can't read an
   opponent's submission until the match resolves, closing the "wait to see
   their move first" RPS exploit).
2. New RPCs: `create_minigame_match` (security invoker) and
   `submit_minigame_result` (security definer — resolves the match once all
   participants submit, computes winner(s)/ties server-side, and atomically
   updates `minigame_scores` for every participant in one transaction instead
   of two untrusted self-reports).
3. *Depends on 1-2.* Rewire [useRoom.ts](../apps/desktop/src/online/useRoom.ts)
   (match creation on challenge-accept / toss-start) and
   [GameView.tsx](../apps/desktop/src/game/GameView.tsx)'s two call sites (RPS
   ~L580, Toss ~L703) to submit raw inputs (move / landing distance) instead
   of a self-derived win/loss boolean.
4. Target Toss is N-player with ties — winner computation must match
   [targetToss.ts](../packages/pet-core/src/minigames/targetToss.ts)'s
   existing tie semantics, not just a 1v1 case.
5. Schema note: add explicit `games_lost` / `games_tied` columns to
   `minigame_scores` (instead of deriving everything from a boolean `p_won`)
   so clean win/loss/tie stats exist later without another migration.

**Phase B — Honest counters, zero economy impact (no loss penalty)**
6. `submit_minigame_result` increments `games_played` / `games_won` /
   `games_lost` / `games_tied` for every participant atomically from the
   resolved match. A win costs nothing, a loss grants nothing — deliberately
   **no care-point or happiness penalty on loss** (a real point/stat penalty
   risks discouraging players from trying minigames for fun; the deterrent
   is that colluding accounts "trading" wins still produce an honest,
   inspectable win/loss record once results are server-resolved).
7. No achievement/reward logic reads these counters yet — deferred to a
   later phase, once real usage data exists to design against.
8. **Residual risk, not a blocker:** honest W/L stats stop the "call the RPC
   with no real opponent" exploit, but don't stop two *consenting* accounts
   from playing real matches where one deliberately throws every game — a
   disposable throwaway's ruined record doesn't matter if nobody uses that
   account for anything else. Only becomes a real problem once
   achievements/rewards attach to raw win *counts*; when that's designed,
   favor things resistant to a farmed throwaway (win-rate with a minimum
   sample size, diminishing credit vs. the same repeat opponent, or requiring
   wins across several distinct opponents) rather than a flat "N wins" tier.
9. Battle follow-up flag (not built in this pass): align
   `applyBattleResult` in [usePetGame.ts](../apps/desktop/src/game/usePetGame.ts)
   with the same policy (persist `battlesWon`/`battlesPlayed`, drop the
   happiness/care-point deltas) once Battle itself is revisited.

**Implementation notes (Phases A+B, 2026-07-20):** Shipped as designed, with
one simplification worth flagging — see "As-built deviations" below for the
Target Toss tie-resolution and `best_score` semantic notes. Chess was left
untouched (still calls `record_minigame_result` directly) — its underlying
match is already server-tracked in `chess_games` with turn-ownership RLS, so
it wasn't in scope for this pass. Battle (item 9) remains un-migrated, as
planned.

**Phase C — Death → penalty conversion**
10. Remove hard death triggered by hunger hitting 0 in
    [replayOfflineGap](../packages/pet-core/src/decay.ts) (consumed via
    `applyDecay` in [usePetGame.ts](../apps/desktop/src/game/usePetGame.ts)).
    Hunger clamps at 0 and stays there instead of flipping `isAlive` false.
11. Replace the 🪦 "didn't make it" screen ([GameView.tsx](../apps/desktop/src/game/GameView.tsx)
    ~L1420) with a distressed/sad visual state (same precedent as the
    existing overfeed "sick 🤢" treatment) — pet stays interactive, feeding it
    resolves the state immediately.
12. Fix the neglect care-point penalty to accumulate **per segment**
    (mirroring how stat decay itself is already segmented into awake/sleep
    pieces) instead of charging the entire gap at the end-state rate.
13. Optional: an extra penalty-rate multiplier (~1.5–2×) specifically while
    hunger sits at 0, so true starvation still stings more than one merely
    low stat — still bounded by `carePointsFloor`, never a full wipe.
14. `restart()` / "Start over" stops being the *only* recovery path from
    neglect — it remains available (e.g. a voluntary reset), but is no
    longer forced by a hunger-triggered death.
15. **Already-dead saves (review addition):** removing death strands any
    existing save with `isAlive: false` — it would sit on a death screen
    that no longer exists. Add a one-time recovery on load: if
    `isAlive === false`, revive into the distressed state (alive, hunger 0)
    instead of rendering dead-state UI.
16. **`isAlive` UI cleanup sweep (review addition):** with death removed,
    audit every `isAlive` consumer — PetEffects' 💀 death-dust block,
    SideDock's `"deceased"` status string, any gating in GameView — and
    remove or repoint them at the new distressed state, so no dead-state UI
    survives with no way to trigger or clear it.
17. **Items 12+13 must share one loop (review addition):** the per-segment
    penalty fix and the hunger-at-0 multiplier both operate on the same
    awake/asleep segment walk — build them together in a single segmented
    pass, not as two separate passes over the gap.

**Implementation notes (Phase C, 2026-07-20):** Shipped per plan. The
tombstone screen's replacement is a one-shot 😢 particle burst
(`PetFxTrigger = "distressed"`, `PetEffects.tsx`) firing once when hunger
crosses to 0, reusing the same somber `Sounds.playDeath` cue and the
existing ambient "🍔 I'm hungry!" bubble for ongoing signaling — not a new
persistent visual filter. "Start over" moved from the (now-removed) death
panel into Settings → Pet, behind a two-click confirm (same pattern as the
existing group-leave warning). **Items 12/13's `<20`-threshold penalty
model and `STARVATION_PENALTY_MULTIPLIER` were replaced the same day — see
Phase F below**, which fully supersedes this section's original penalty
math (the death removal / distressed-state / revive-on-load / restart
changes above are unaffected and unchanged).

**Phase D — Small carry-over (poop cleanup balance)**
18. Cap the planned poop-cleanup reward (from
    [docs/plan-uiOverhaulAmdChess.md](./plan-uiOverhaulAmdChess.md)'s Phase 0
    item 4) at ~2 care points + a small happiness bump, low spawn rate
    (~1-2/day), and **not** counted toward qualified-action quest progress
    (Balanced Care / Guardians) — keeps it a flavor bonus, not a second
    progression rail, alongside the existing feed/wash/pet/ball economy.

**Implementation notes (Phase D, 2026-07-20):** `spawnChance` lowered
0.35 → 0.15 and a new `minGapMs` (8h) real-time throttle added to
`POOP_RULES`/`shouldSpawnPoop` — spawn-chance alone can't cap a
per-feed-event roll at "~1-2/day" against a very active feeder, so the gap
gate is the actual enforcement; chance is just flavor variance on top.
Reward (2 care points + 3 happiness) and quest-progress exclusion were
already correct pre-existing behavior, confirmed unchanged.

**Phase E — Nested-home status effects + house liveliness** *(implemented
Jul 2026, same session as this review)*
19. **Bug fix:** while the pet is nested (`petNested`), the roaming
    `<PetEffects>` overlay (stink waves / hunger bubble) kept rendering at a
    frozen snapshot of the nest slot's coordinates — the pet's hidden
    roaming container stops tracking the dock the moment it moves/collapses,
    so effects appeared "in a random place." Fix: gate the roaming
    `<PetEffects>` on `!petNested` and instead render a compact
    `NestStatusFx` (scaled-down smell waves + hunger bubble, same
    thresholds: cleanliness < 30, hunger/warmth < 25) anchored directly to
    the `[data-homeslot]` nest slot in SideDock.
20. **Collapsed-dock visibility:** while nested with the dock collapsed, a
    small pulsing 💨 / 🍔 (🥶 for an egg) badge overlays the collapsed Home
    tab icon so neglect is never invisible — complements the existing 🪺
    nested badge.
21. **House liveliness:** while the pet is inside, the pet's OWN art inside
    the nest slot (`NestedPetSprite`) breathes via the existing
    `pet-anim-idle-breathe` CSS class, plus an occasional random wiggle
    (`egg-anim-wiggle`, random 6–10s cadence) — a follow-up fix moved this
    off the circular slot container itself (2026-07-20: the container's own
    framer hover-scale animation was reading as "the badge is breathing,"
    not the pet — see the item 21 follow-up note below). The collapsed Home
    tab icon still breathes/wiggles itself, since there's no separate pet
    art visible there.

    *Follow-up (2026-07-20, same day as initial ship):* two user-reported
    issues fixed — (1) breathing/wiggle animate the pet's own sprite/emoji
    now (`NestedPetSprite`'s `wiggle` prop), not the outer slot circle,
    which previously carried a competing framer `animate={{scale, rotate}}`
    that visually dominated the sprite's much subtler CSS keyframe; (2)
    wiggle cadence tightened from 6–20s to 6–10s per user request.

**Phase F — Care-point decay rebalance + protected-sleep rework + AFK
summary** *(2026-07-20, same day as Phase C — superseding its penalty math)*

Live testing with the admin panel's time-jump buttons showed Phase C's
`<20`-threshold penalty model was still far too harsh (up to ~52 pts/hour
once starving, wiping a whole evolution stage's progress in ~24h) and that
protected sleep was an absolute freeze players could exploit to park a pet
forever with zero cost. Three changes:

22. **Care points now drain ONLY for the minutes a stat sits at EXACTLY
    0** — a merely-low stat (even at 1) costs nothing. Rate:
    `rules.carePointDecay.perMinutePerZeroStat = 0.05` (~3 pts/hour per
    empty stat, ~72/day), summed across however many of the three stats
    (careNeed/cleanliness/happiness) are at 0 simultaneously. Computed per
    decay segment from that segment's OWN start value via a new
    `minutesAtZero(startValue, ratePerMin, segmentMinutes)` helper in
    `decay.ts` — a stat that crosses to 0 partway through a segment is only
    charged for the remainder, not the whole segment. Still bounded below
    by `carePointsFloor` — never a full wipe. `STARVATION_PENALTY_MULTIPLIER`
    and the old `<20`-threshold `segmentPenalty` helper are removed.
23. **Protected (manual tuck-in) sleep decays instead of freezing** — hunger
    now decays at the normal sleep rate but is floored at
    `rules.sleep.protectedStatFloor` (10), never below, for as long as the
    72h `protectedMaxMs` window holds (kept unchanged). A stat already
    below the floor at tuck-in time is left exactly where it is, never
    raised up to 10 (the old code's `Math.max(stat, floor)` would have
    raised it — fixed). Cleanliness/happiness are untouched during
    protected sleep, same as any other sleep (sleep decay has never touched
    them, protected or not — unrelated to this rework). Because the floor
    keeps careNeed above 0 the whole protected portion, it costs zero care
    points by construction; once the 72h cap lapses mid-gap, the floor
    lifts and normal (unfloored) decay + the zero-stat penalty resume for
    the remainder only.
24. **AFK summary**: a dismissible card above the pet (same visual pattern
    as the update-ready notice) shows "😴 While you were away (Xh Ym)" plus
    each stat's drop and any care points lost, whenever an applied decay
    gap is ≥30 minutes (`AFK_SUMMARY_MIN_MINUTES` in `usePetGame.ts`) —
    covers app-reopen after a long close, cloud sign-in with a large
    server-side gap, a machine waking from sleep mid-session (the live
    tick firing late), and the admin panel's time-jump buttons (which
    always force it, regardless of the 30-minute floor, as a preview
    tool). The same gap also appends a Care-history entry (`category:
    "penalty"` if care points were lost, else `"care"`), e.g. *"While away
    5h 12m — hunger −42, cleanliness −60, ⭐ −16"*.

**Simulation table** (evolutionStage "adult," carePoints 800/floor 450 so
decay isn't exempted by the pending-evolution freeze; egg row uses its own
hatch-stage numbers):

| Scenario | Gap | End stats | Care points lost |
|---|---|---|---|
| Full stats close | 24h | hunger 0, clean 40, happy 70 | 16.5 |
| Full stats close | 48h | hunger 0, clean 40, happy 70 | 88.5 |
| Full stats close | 7d | hunger 0, clean 40, happy 70 | 350.0 (floor hit) |
| Hunger-30 close | 24h | hunger 0, clean 40, happy 70 | 69.0 |
| Hunger-30 close | 48h | hunger 0, clean 40, happy 70 | 141.0 |
| Neglect close (all 50) | 7d | hunger 0, clean 0, happy 20 | 350.0 (floor hit) |
| Protected sleep (within 72h cap) | 48h | hunger 10 (floor) | 0.0 |
| Protected sleep (24h past cap) | 96h | hunger 0 | 64.5 |
| Protected sleep (cap long lapsed) | 30d | hunger 0 | 350.0 (floor hit) |
| Egg abandoned | 7d | warmth 0 | 300.0 (full pre-hatch progress) |

Reads as intended: a normal weekend away costs tens of points, not
hundreds; a full week of total neglect costs a bounded ~350 (this test's
floor gap), never more regardless of how much longer it drags on; tucking
in before a long absence is genuinely protective (0 lost within 72h) but
not an infinite exploit (cost resumes, at the same slow rate, once the cap
lapses).

**Files**: `packages/pet-core/src/rules.ts` (`PetCarePointDecayRules`,
`carePointDecay` on `DEFAULT_PET_RULES`/overrides/merge), `decay.ts`
(`minutesAtZero`, `segmentZeroStatPenalty`, `protectedFloorValue` replacing
`segmentPenalty`/`STARVATION_PENALTY_MULTIPLIER`), `decay.test.ts` (24
cases, all rewritten/added for the new model), `usePetGame.ts`
(`AfkGapSummary` type, `applyDecay` now returns `{save, summary}`,
`afkSummary` state + `maybeSetAfkSummary`/`dismissAfkSummary`, wired into
all four `applyDecay` call sites: initial load, cloud-load, live tick,
`debugTimeJump`), `GameView.tsx` (AFK card), `SideDock.tsx` (sleep message
moved from Pet Stats to Home, reworded for the floor-not-freeze behavior).

## As-built deviations from this plan's original sketch

- **Match identity**: rather than deriving a match key, both/all
  participants agree on a shared `uuid` generated client-side — the RPS
  acceptor mints one and includes it in the "accept" broadcast; the Target
  Toss host mints one at game-start and includes it alongside the shared
  seed/turn order. Every participant calls `create_minigame_match` with
  that same id (idempotent — `on conflict (id) do nothing`), so the row
  always ends up with the correct participant set regardless of network
  ordering.
- **Target Toss server-side tie handling is a simplification**: the RPC
  computes winner(s) as everyone tied for the lowest submitted
  `total_distance` (co-winners), which matches `targetToss.ts`'s
  tie-as-co-winners *fallback* — it does NOT replicate the interactive
  sudden-death round (extra live throws), since that needs real-time
  player input the RPC has no way to prompt for. In practice this rarely
  differs from the client-side result: sudden death only ever changes the
  outcome when two totals were exactly, coincidentally equal AND a
  sudden-death throw broke the tie — an edge case, not the common path.
- **`best_score` semantic shift**: now stores the lowest per-game *total*
  distance across all rounds (matching the actual golf-scoring winner
  rule), not the lowest *single throw* the old `record_minigame_result`
  call recorded. More consistent with how the winner is actually decided;
  flagged here since it changes what existing `minigame_scores` rows mean
  going forward (old rows aren't retroactively reinterpreted).
- **Forfeit ("Give up") in Target Toss doesn't resolve instantly
  server-side**: the quitter's local loss still logs immediately
  (history-only, zero economy impact either way), but the match record
  only resolves once every remaining participant has also submitted — a
  forfeiting player's `games_played`/`games_lost` write lands whenever the
  match eventually concludes for everyone, not the moment they quit. Their
  submitted total is inflated by `MISS_PENALTY_DISTANCE` per remaining
  unplayed round so they can never accidentally still "win" once it does
  resolve.
- **Chess untouched**: still self-reports via the original
  `record_minigame_result`, deliberately out of scope (see Phase A/B
  implementation notes above).

## Relevant files
- [`supabase/migrations/20260720000000_minigame_matches.sql`](../supabase/migrations/20260720000000_minigame_matches.sql) — `minigame_matches` + `minigame_match_submissions` (sealed-until-resolved RLS) + `games_lost`/`games_tied` on `minigame_scores` + `create_minigame_match`/`submit_minigame_result` RPCs. **Not pushed yet** — needs `supabase db push`.
- [`supabase/migrations/20260713010000_minigame_scores.sql`](../supabase/migrations/20260713010000_minigame_scores.sql) — unchanged; `record_minigame_result` stays live for chess only.
- [`apps/desktop/src/online/useRoom.ts`](../apps/desktop/src/online/useRoom.ts) — `matchId` threaded through `ActiveMinigame`/`TargetTossState`, `createMinigameMatch` helper called on RPS accept (both sides) and Toss game-start (all participants).
- [`apps/desktop/src/game/GameView.tsx`](../apps/desktop/src/game/GameView.tsx) — `onMinigameResolved` (RPS) and the Target Toss game-over effect + `forfeitToss` now call `submit_minigame_result` instead of `record_minigame_result`; the death screen/sprite/panel are removed (see Phase C notes) and replaced by a one-shot "distressed" particle trigger.
- [`packages/pet-core/src/decay.ts`](../packages/pet-core/src/decay.ts), [`packages/pet-core/src/decay.test.ts`](../packages/pet-core/src/decay.test.ts) — per-segment penalty + `STARVATION_PENALTY_MULTIPLIER`, hard death removed.
- [`apps/desktop/src/game/usePetGame.ts`](../apps/desktop/src/game/usePetGame.ts) — `reviveIfDead` (one-time legacy-save recovery, wired into `applyDecay`); `restart`/`applyBattleResult` unchanged, `applyBattleResult` still flagged for the Battle follow-up.
- [`apps/desktop/src/game/PetEffects.tsx`](../apps/desktop/src/game/PetEffects.tsx) — `NestStatusFx` (Phase E), `"distressed"` trigger + death-dust removal (Phase C).
- [`apps/desktop/src/game/SideDock.tsx`](../apps/desktop/src/game/SideDock.tsx) — nest-slot liveliness/status fx (Phase E), Settings → Pet "Start over" (Phase C item 14), `"deceased"` status string removed.
- [`packages/pet-core/src/poop.ts`](../packages/pet-core/src/poop.ts), [`packages/pet-core/src/poop.test.ts`](../packages/pet-core/src/poop.test.ts) — `minGapMs` throttle + lowered `spawnChance` (Phase D).
- [`packages/pet-core/src/achievements.ts`](../packages/pet-core/src/achievements.ts) — no changes yet, but future win/loss-based achievement tiers should land here later per Phase B item 8's guardrail

## Verification
1. Two accounts play RPS — resolution only fires after both submit;
   `minigame_scores` updates once per match; a solo scripted RPC call with no
   matching opponent submission never resolves.
2. Sealed-submission RLS: can't read an opponent's pending move before
   resolution.
3. Target Toss with 3+ players resolves ties correctly, matching
   `targetToss.ts`'s existing semantics.
4. Win = 0 care points / 0 happiness delta; loss = 0 care points / 0
   happiness delta — only `games_played`/`games_won`/`games_lost`/`games_tied`
   move.
5. Hunger reaching 0 no longer kills the pet; it stays interactive in a
   distressed state and recovers immediately on feeding.
6. New `decay.test.ts` case: a stat that only dips low near the end of a long
   gap isn't charged the penalty rate for the entire gap, only the low
   segment.
7. Manually simulate hunger=30/50/100-at-close scenarios (admin panel's
   time-jump buttons) and confirm the pet survives all of them in the
   distressed state rather than dying, with a care-point cost bounded by
   `carePointsFloor`.

## Decisions
- Build real server-authoritative match records (sealed submissions + atomic
  server-side resolution), not just a design-level deterrent — closes the
  "fabricate a result with no opponent" hole outright.
- No care-point/happiness penalty on minigame losses — the deterrent is an
  honest, server-resolved win/loss/tie record, not a stat cost; a real
  penalty risks discouraging casual play.
- Minigame/combat win/loss counters are tracked now but **not** wired to any
  achievement/reward yet — that design is explicitly deferred until there's
  real usage data, with an explicit guardrail against flat "N wins" tiers
  given the throwaway-account collusion risk.
- Battle's existing progression reward (+10/+6/-3) is left untouched in this
  pass — flagged as inconsistent with the new policy, to be aligned when
  Battle itself is redesigned, not bundled here.
- Death is converted to a bounded care-point penalty (via the existing
  `carePointsFloor` mechanic), never a full wipe of evolution stage or
  achievement-counter progress — replacing the current death+restart flow's
  harsher, all-or-nothing blast radius.
- Poop cleanup stays capped as a minor flavor bonus, explicitly excluded from
  qualified-action quest progress.

## Future ideas (unscheduled backlog — not part of this plan)

Curated brainstorm, roughly ordered by leverage over existing systems. None
of these are committed; each should get its own design pass before building.

1. **Tic-Tac-Toe** — third 1:1 minigame; near-free reuse of the Chess
   ribbon/forfeit plumbing, and a good first consumer of Phase A's
   server-authoritative match records.
2. **Pet Racing** — room-wide timing-tap race reusing the Target Toss lobby
   (invite/ready/start) infrastructure; everyone's pets run across the
   screen together.
3. **Pet-to-pet autoplay** — when two pets in a room idle near each other,
   they occasionally play (chase, nuzzle, ball pass) with emote bubbles;
   makes rooms feel alive with zero player input.
4. **Gift sending** — send a friend a snack/toy via the existing group/room
   channel; small happiness bump with a daily cap (consistent with this
   plan's anti-farming stance).
5. **Time-of-day awareness** — pet yawns at night, stretches in the
   morning; a soft nudge toward the tuck-in mechanic.
6. **Walk-mode collectibles** — during Follow Me, occasionally spawn a
   findable item (feather/shell) the pet sniffs out; purely cosmetic
   collection album.
7. **Photo mode** — freeze frame, pick a pose/emote, save a PNG; shareable
   and zero economy impact.
8. **Visit a friend's home** — see their nest/house with their pet inside;
   leave a one-emote "ring the doorbell" reaction.
