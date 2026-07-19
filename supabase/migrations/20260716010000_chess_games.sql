-- Chess minigame (Jul 2026 plan, Phase 3). One row per game, stored against
-- the group whose room it was started in. Untimed-only for v1: no
-- mode/clock/time-bank columns — a game lives here until checkmate,
-- resignation, or a mutual/unreachable cancel resolves it.
--
-- Trust model (MVP, flagged in the plan): clients validate move LEGALITY
-- locally with chess.js; the DB only enforces turn ownership on updates
-- (the update policy's USING clause checks the EXISTING row's current_turn
-- against auth.uid()) plus player membership. Full server-side move
-- re-validation is a hardening follow-up — same class of decision as the
-- "Realtime private-channel authorization" note in useRoom.ts.
--
-- Endings:
--   status 'finished'  + result_reason 'checkmate' | 'resignation' | 'draw'
--     → decisive (or drawn) — each player's client records its own
--       minigame_scores row ('chess', games_won on the winner).
--   status 'abandoned' + result_reason 'mutual_cancel' | 'opponent_unreachable'
--     → NO score impact for either side; just frees the pair (see the
--       one-active-game-per-pair index) to start a new game.
-- A silent app-close/disconnect NEVER resolves a game — only these
-- explicit endings do.

create table public.chess_games (
  id            uuid primary key default gen_random_uuid(),
  group_id      uuid not null references public.groups (id) on delete cascade,
  -- player_a is WHITE (the challenger), player_b is BLACK (the acceptor).
  player_a_id   uuid not null references public.profiles (id) on delete cascade,
  player_b_id   uuid not null references public.profiles (id) on delete cascade,
  board_fen     text not null default 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  -- Full SAN log (jsonb array of strings) — needed for resume; the
  -- in-panel "recent moves" widget just reads a slice of this same array.
  move_history  jsonb not null default '[]'::jsonb,
  current_turn  uuid not null references public.profiles (id),
  status        text not null default 'active'
                  check (status in ('active', 'finished', 'abandoned')),
  winner_id     uuid references public.profiles (id),
  result_reason text
                  check (result_reason in
                    ('checkmate', 'resignation', 'draw', 'mutual_cancel', 'opponent_unreachable')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (player_a_id <> player_b_id)
);

-- One ACTIVE game per pair (order-insensitive): a new challenge between the
-- same two players is blocked until the existing game resolves (finished OR
-- abandoned). The challenge flow surfaces this as a friendly "you already
-- have a game with them" message rather than a raw constraint error.
create unique index chess_games_one_active_per_pair
  on public.chess_games (least(player_a_id, player_b_id), greatest(player_a_id, player_b_id))
  where status = 'active';

create index chess_games_group_active_idx
  on public.chess_games (group_id) where status = 'active';

alter table public.chess_games enable row level security;

-- Spectator read: any member of the game's GROUP may watch. NOTE: this must
-- be is_group_member(group_id) — shares_group_with() takes a USER id
-- ("does auth.uid() share a group with this user"), so passing a group_id
-- into it would silently never match.
create policy "chess games: group members read"
  on public.chess_games for select
  using (public.is_group_member(group_id));

-- Only a would-be player creates a game, inside a group they belong to,
-- with themselves as one of the two players.
create policy "chess games: players insert"
  on public.chess_games for insert
  with check (
    auth.uid() in (player_a_id, player_b_id)
    and public.is_group_member(group_id)
  );

-- Moves: turn-ownership enforced by RLS — only the player whose turn it is
-- (per the EXISTING row) can update an active game. Resign/cancel (which an
-- off-turn player must be able to do) go through the SECURITY DEFINER RPCs
-- below instead, never a direct update.
create policy "chess games: current player moves"
  on public.chess_games for update
  using (status = 'active' and auth.uid() = current_turn)
  with check (auth.uid() in (player_a_id, player_b_id));

grant select, insert, update on public.chess_games to authenticated;

-- Resign ("Give up"): decisive — the caller takes the loss, the opponent
-- gets the win. Definer because RLS's update policy only lets the
-- current-turn player write, and resigning must work off-turn too.
create or replace function public.resign_chess_game(p_game_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  g chess_games%rowtype;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  select * into g from chess_games where id = p_game_id for update;
  if not found then
    raise exception 'game not found';
  end if;
  if auth.uid() not in (g.player_a_id, g.player_b_id) then
    raise exception 'not a player in this game';
  end if;
  if g.status <> 'active' then
    raise exception 'game is not active';
  end if;
  update chess_games
     set status = 'finished',
         winner_id = case when auth.uid() = g.player_a_id then g.player_b_id else g.player_a_id end,
         result_reason = 'resignation',
         updated_at = now()
   where id = p_game_id;
end;
$$;

-- Cancel: ends the game with NO score impact for either side.
--   'mutual_cancel'        — the opponent explicitly accepted the proposal
--                            (handshake happens over Realtime; either side
--                            then calls this).
--   'opponent_unreachable' — unilateral escape hatch after the opponent has
--                            shown no room presence for the client-side
--                            grace period (48h placeholder, tunable). MVP
--                            trust: the server can't verify presence, so
--                            the grace gate lives client-side.
create or replace function public.cancel_chess_game(p_game_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  g chess_games%rowtype;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if p_reason not in ('mutual_cancel', 'opponent_unreachable') then
    raise exception 'invalid cancel reason';
  end if;
  select * into g from chess_games where id = p_game_id for update;
  if not found then
    raise exception 'game not found';
  end if;
  if auth.uid() not in (g.player_a_id, g.player_b_id) then
    raise exception 'not a player in this game';
  end if;
  if g.status <> 'active' then
    raise exception 'game is not active';
  end if;
  update chess_games
     set status = 'abandoned',
         winner_id = null,
         result_reason = p_reason,
         updated_at = now()
   where id = p_game_id;
end;
$$;

grant execute on function public.resign_chess_game(uuid) to authenticated;
grant execute on function public.cancel_chess_game(uuid, text) to authenticated;
revoke execute on function public.resign_chess_game(uuid) from anon;
revoke execute on function public.cancel_chess_game(uuid, text) from anon;
