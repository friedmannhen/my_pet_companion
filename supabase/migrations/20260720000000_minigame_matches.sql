-- Server-authoritative minigame matches (Phase A,
-- docs/plan-deathDecayMinigameBalance.md) — closes the "call
-- record_minigame_result with no real opponent" hole for RPS and Target
-- Toss. Chess is intentionally NOT touched here: chess_games is already a
-- server-tracked row with turn-ownership RLS, so its existing
-- record_minigame_result self-report call sites stay as-is.
--
-- Protocol: both/all real participants already agree on a shared match id
-- client-side (the RPS acceptor generates one and broadcasts it; the Target
-- Toss host generates one at game-start and broadcasts it alongside the
-- shared seed/turn order — see useRoom.ts). Each participant calls
-- create_minigame_match once (idempotent — on conflict do nothing, whoever
-- arrives first wins) and submit_minigame_result once with their own raw
-- result payload. The LAST participant's submit resolves the match
-- atomically: computes winner(s) server-side and folds games_played/won/
-- lost/tied into minigame_scores for every participant in one transaction,
-- instead of N untrusted self-reports.
--
-- Submissions are SEALED until resolution (a participant can never read an
-- opponent's pending payload before the match resolves) — closes the "wait
-- to see their move first" exploit for a client that skipped the real
-- realtime handshake entirely.

create table public.minigame_matches (
  id              uuid primary key,
  game_code       text not null check (game_code in ('rps', 'target_toss')),
  participant_ids uuid[] not null,
  status          text not null default 'pending' check (status in ('pending', 'resolved')),
  winner_ids      uuid[],
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz
);

alter table public.minigame_matches enable row level security;

create policy "minigame matches: participant read"
  on public.minigame_matches for select
  using (auth.uid() = any (participant_ids));

-- Only a participant may create a match row FOR THEMSELVES (create_minigame_match
-- runs security invoker, so this check applies to the RPC's own insert).
-- No update policy for authenticated at all — resolution only happens
-- inside submit_minigame_result's security definer context.
create policy "minigame matches: participant creates"
  on public.minigame_matches for insert
  with check (auth.uid() = any (participant_ids));

grant select, insert on public.minigame_matches to authenticated;

create table public.minigame_match_submissions (
  match_id     uuid not null references public.minigame_matches (id) on delete cascade,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  payload      jsonb not null,
  submitted_at timestamptz not null default now(),
  primary key (match_id, user_id)
);

alter table public.minigame_match_submissions enable row level security;

-- Sealed: a participant can read their OWN pending submission, and anyone's
-- submission (including opponents') only once the match has resolved.
create policy "minigame submissions: own row or resolved match"
  on public.minigame_match_submissions for select
  using (
    auth.uid() = user_id
    or exists (
      select 1 from public.minigame_matches m
      where m.id = minigame_match_submissions.match_id
        and m.status = 'resolved'
        and auth.uid() = any (m.participant_ids)
    )
  );

-- No insert/update policy for authenticated — writes only happen inside
-- submit_minigame_result's security definer context (RPC-gated writes,
-- same pattern as group_memberships).
grant select on public.minigame_match_submissions to authenticated;

-- Explicit win/loss/tie columns instead of deriving everything from a
-- boolean p_won (the old record_minigame_result shape).
alter table public.minigame_scores add column if not exists games_lost integer not null default 0;
alter table public.minigame_scores add column if not exists games_tied integer not null default 0;

create or replace function public.create_minigame_match(
  p_match_id uuid,
  p_game_code text,
  p_participant_ids uuid[]
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
  if p_game_code not in ('rps', 'target_toss') then
    raise exception 'unknown game_code %', p_game_code;
  end if;
  if p_game_code = 'rps' and coalesce(array_length(p_participant_ids, 1), 0) <> 2 then
    raise exception 'rps requires exactly 2 participants';
  end if;
  if coalesce(array_length(p_participant_ids, 1), 0) < 2 then
    raise exception 'a match needs at least 2 participants';
  end if;
  if not (auth.uid() = any (p_participant_ids)) then
    raise exception 'caller is not a participant';
  end if;

  insert into minigame_matches (id, game_code, participant_ids)
  values (p_match_id, p_game_code, p_participant_ids)
  on conflict (id) do nothing;
end;
$$;

grant execute on function public.create_minigame_match(uuid, text, uuid[]) to authenticated;
revoke execute on function public.create_minigame_match(uuid, text, uuid[]) from anon;

create or replace function public.submit_minigame_result(
  p_match_id uuid,
  p_payload jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_match record;
  v_submission_count integer;
  v_participant_count integer;
  v_winner_ids uuid[];
  m1_user uuid;
  m1_move text;
  m2_user uuid;
  m2_move text;
  beats jsonb := '{"rock":"scissors","paper":"rock","scissors":"paper"}'::jsonb;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select * into v_match from minigame_matches where id = p_match_id for update;
  if not found then
    raise exception 'match not found — call create_minigame_match first';
  end if;
  if not (auth.uid() = any (v_match.participant_ids)) then
    raise exception 'caller is not a participant';
  end if;
  if v_match.status <> 'pending' then
    -- Already resolved (e.g. a late/duplicate submit racing the resolving
    -- call) — idempotent no-op, not an error.
    return;
  end if;

  insert into minigame_match_submissions (match_id, user_id, payload)
  values (p_match_id, auth.uid(), p_payload)
  on conflict (match_id, user_id) do update set payload = excluded.payload, submitted_at = now();

  select count(*) into v_submission_count from minigame_match_submissions where match_id = p_match_id;
  v_participant_count := array_length(v_match.participant_ids, 1);
  if v_submission_count < v_participant_count then
    return; -- waiting on the rest of the participants
  end if;

  if v_match.game_code = 'rps' then
    select user_id, payload ->> 'move' into m1_user, m1_move
      from minigame_match_submissions where match_id = p_match_id order by user_id asc limit 1;
    select user_id, payload ->> 'move' into m2_user, m2_move
      from minigame_match_submissions where match_id = p_match_id order by user_id desc limit 1;
    if m1_move = m2_move then
      v_winner_ids := '{}';
    elsif beats ->> m1_move = m2_move then
      v_winner_ids := array[m1_user];
    else
      v_winner_ids := array[m2_user];
    end if;
  elsif v_match.game_code = 'target_toss' then
    -- Lowest submitted total_distance wins (golf scoring, matches
    -- targetToss.ts's totalDistanceLeaders); several = exactly tied →
    -- co-winners. Note: this mirrors the tie-as-co-winners FALLBACK, not
    -- targetToss.ts's interactive sudden-death round — the sudden-death
    -- arbitration itself stays client-side/deterministic-seed, since it
    -- requires live extra turns this RPC has no way to prompt for.
    select coalesce(array_agg(s.user_id), '{}') into v_winner_ids
    from (
      select user_id, (payload ->> 'total_distance')::numeric as d
      from minigame_match_submissions where match_id = p_match_id
    ) s
    where s.d = (
      select min((payload ->> 'total_distance')::numeric)
      from minigame_match_submissions where match_id = p_match_id
    );
  else
    raise exception 'unknown game_code %', v_match.game_code;
  end if;

  update minigame_matches
    set status = 'resolved', winner_ids = v_winner_ids, resolved_at = now()
    where id = p_match_id;

  insert into minigame_scores (user_id, game_code, games_played, games_won, games_lost, games_tied)
  select
    p,
    v_match.game_code,
    1,
    case when coalesce(array_length(v_winner_ids, 1), 0) > 0 and p = any (v_winner_ids) then 1 else 0 end,
    case when coalesce(array_length(v_winner_ids, 1), 0) > 0 and not (p = any (v_winner_ids)) then 1 else 0 end,
    case when coalesce(array_length(v_winner_ids, 1), 0) = 0 then 1 else 0 end
  from unnest(v_match.participant_ids) as p
  on conflict (user_id, game_code) do update set
    games_played = minigame_scores.games_played + 1,
    games_won    = minigame_scores.games_won + excluded.games_won,
    games_lost   = minigame_scores.games_lost + excluded.games_lost,
    games_tied   = minigame_scores.games_tied + excluded.games_tied,
    updated_at   = now();

  -- best_score for target_toss = lowest GAME TOTAL achieved (consistent
  -- with the winner rule above) — least(...) against the submitted total,
  -- same "lower is better" convention record_minigame_result used.
  if v_match.game_code = 'target_toss' then
    update minigame_scores ms
      set best_score = least(coalesce(ms.best_score, sub.d), sub.d)
      from (
        select user_id, (payload ->> 'total_distance')::numeric as d
        from minigame_match_submissions where match_id = p_match_id
      ) sub
      where ms.user_id = sub.user_id and ms.game_code = 'target_toss';
  end if;
end;
$$;

grant execute on function public.submit_minigame_result(uuid, jsonb) to authenticated;
revoke execute on function public.submit_minigame_result(uuid, jsonb) from anon;
