# Plan: Death → Penalty Conversion + Minigame/Combat Anti-Farming

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

**Phase D — Small carry-over (poop cleanup balance)**
15. Cap the planned poop-cleanup reward (from
    [docs/plan-uiOverhaulAmdChess.md](./plan-uiOverhaulAmdChess.md)'s Phase 0
    item 4) at ~2 care points + a small happiness bump, low spawn rate
    (~1-2/day), and **not** counted toward qualified-action quest progress
    (Balanced Care / Guardians) — keeps it a flavor bonus, not a second
    progression rail, alongside the existing feed/wash/pet/ball economy.

## Relevant files
- New: `supabase/migrations/2026xxxx_minigame_matches.sql`
- [`supabase/migrations/20260713010000_minigame_scores.sql`](../supabase/migrations/20260713010000_minigame_scores.sql) — add `games_lost`/`games_tied`; direct client self-report calls retired in favor of `submit_minigame_result`
- [`apps/desktop/src/online/useRoom.ts`](../apps/desktop/src/online/useRoom.ts), [`apps/desktop/src/game/GameView.tsx`](../apps/desktop/src/game/GameView.tsx) (~L580 RPS, ~L703 Toss, ~L1420 death screen)
- [`packages/pet-core/src/decay.ts`](../packages/pet-core/src/decay.ts), [`packages/pet-core/src/decay.test.ts`](../packages/pet-core/src/decay.test.ts)
- [`apps/desktop/src/game/usePetGame.ts`](../apps/desktop/src/game/usePetGame.ts) (`applyDecay`, `restart`, `applyBattleResult` follow-up flag)
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
