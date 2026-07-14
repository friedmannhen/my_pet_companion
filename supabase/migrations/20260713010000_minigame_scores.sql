-- Minigame results (plan: room mini-game framework — Game 1 "Target Toss",
-- already consumed today by Rock-Paper-Scissors). One row per
-- (user, game_code); progression rewards are deliberately NOT granted for
-- minigames — this table exists so future achievements/leaderboards can read
-- lifetime results.
--
-- game_code values so far: 'rps' (Rock-Paper-Scissors), 'target_toss'
-- (planned). best_score semantics are per-game (lower = better for
-- target_toss's distance; unused/null for rps).

create table public.minigame_scores (
  user_id      uuid not null references public.profiles (id) on delete cascade,
  game_code    text not null,
  best_score   numeric,
  games_played integer not null default 0,
  games_won    integer not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (user_id, game_code)
);

alter table public.minigame_scores enable row level security;

-- Shared-group read so leaderboards can show friends' results (mirrors
-- pets/achievements visibility).
create policy "minigame scores: owner or shared-group read"
  on public.minigame_scores for select
  using (auth.uid() = user_id or public.shares_group_with(user_id));

create policy "minigame scores: owner inserts"
  on public.minigame_scores for insert
  with check (auth.uid() = user_id);

create policy "minigame scores: owner updates"
  on public.minigame_scores for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update on public.minigame_scores to authenticated;

-- Atomic upsert so concurrent game-ends never lose a count to a client-side
-- read-modify-write race. SECURITY INVOKER: only ever touches the caller's
-- own row (RLS still applies).
create or replace function public.record_minigame_result(
  p_game_code text,
  p_distance numeric,
  p_won boolean
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  insert into minigame_scores (user_id, game_code, best_score, games_played, games_won)
  values (auth.uid(), p_game_code, p_distance, 1, case when p_won then 1 else 0 end)
  on conflict (user_id, game_code) do update set
    best_score   = least(coalesce(minigame_scores.best_score, excluded.best_score), excluded.best_score),
    games_played = minigame_scores.games_played + 1,
    games_won    = minigame_scores.games_won + case when p_won then 1 else 0 end,
    updated_at   = now();
end;
$$;

grant execute on function public.record_minigame_result(text, numeric, boolean) to authenticated;
