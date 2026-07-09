-- ============================================================================
-- Foundation schema (Phase 1) — my_pet_companion
-- Normalized replacement for the old one-JSON-blob-per-user RestHeart model.
-- Authorization model (plan §5): a user can read/write their OWN rows via RLS;
-- cross-user reads require a shared group; every cross-user MUTATION goes
-- through an Edge Function (service role) — never a direct client write.
-- Licenses & session leases are written ONLY by Edge Functions.
-- ============================================================================

-- ── Enums ───────────────────────────────────────────────────────────────────
create type public.pet_type as enum
  ('cat', 'dog', 'dino', 'dragon', 'ghost', 'robot', 'phoenix');

create type public.sleep_kind as enum ('manual', 'auto');

create type public.group_type as enum
  ('organization', 'friend_circle', 'custom', 'global');

create type public.membership_role as enum ('owner', 'admin', 'member');

create type public.plan_type as enum ('individual', 'organization', 'beta');

create type public.license_status as enum ('active', 'expired', 'canceled');

create type public.device_type as enum ('desktop', 'extension', 'web');

create type public.achievement_status as enum ('claimable', 'claimed');

-- ── Profiles ────────────────────────────────────────────────────────────────
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  name        text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles: read own"
  on public.profiles for select
  using (auth.uid() = id);

create policy "profiles: update own"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- ── Groups & memberships ────────────────────────────────────────────────────
create table public.groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  group_type  public.group_type not null default 'custom',
  owner_id    uuid references public.profiles (id) on delete set null,
  invite_code text unique,
  created_at  timestamptz not null default now()
);

create table public.group_memberships (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  group_id   uuid not null references public.groups (id) on delete cascade,
  role       public.membership_role not null default 'member',
  joined_at  timestamptz not null default now(),
  primary key (user_id, group_id)
);

create index group_memberships_group_idx on public.group_memberships (group_id);

-- The singleton Global group every user auto-joins at signup (plan §8) —
-- fixed UUID so clients/functions can reference it without a lookup.
insert into public.groups (id, name, group_type)
values ('00000000-0000-0000-0000-000000000001', 'Global', 'global');

-- Helper: do two users share at least one group? (security definer so RLS
-- policies can use it without recursive-policy problems)
create or replace function public.shares_group_with(other uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from group_memberships a
    join group_memberships b on a.group_id = b.group_id
    where a.user_id = auth.uid() and b.user_id = other
  );
$$;

-- Helper: is the current user a member of the given group?
create or replace function public.is_group_member(gid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from group_memberships
    where user_id = auth.uid() and group_id = gid
  );
$$;

alter table public.groups enable row level security;
alter table public.group_memberships enable row level security;

create policy "groups: members read"
  on public.groups for select
  using (public.is_group_member(id));

create policy "groups: any user creates (becomes owner)"
  on public.groups for insert
  with check (auth.uid() = owner_id and group_type in ('friend_circle', 'custom'));

create policy "groups: owner updates"
  on public.groups for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create policy "groups: owner deletes (never global)"
  on public.groups for delete
  using (auth.uid() = owner_id and group_type <> 'global');

create policy "memberships: read own + same-group"
  on public.group_memberships for select
  using (user_id = auth.uid() or public.is_group_member(group_id));

-- Joining via invite code and removals go through Edge Functions / the signup
-- trigger; group owners may remove members directly.
create policy "memberships: owner removes members"
  on public.group_memberships for delete
  using (
    exists (
      select 1 from public.groups g
      where g.id = group_id and g.owner_id = auth.uid()
    )
    or user_id = auth.uid() -- leaving a group yourself
  );

-- ── Pets (one row per user × pet type) ──────────────────────────────────────
create table public.pets (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles (id) on delete cascade,
  pet_type         public.pet_type not null,
  name             text not null,
  hunger           numeric(6,3) not null default 50 check (hunger between 0 and 100),
  warmth           numeric(6,3) not null default 50 check (warmth between 0 and 100),
  cleanliness      numeric(6,3) not null default 20 check (cleanliness between 0 and 100),
  happiness        numeric(6,3) not null default 20 check (happiness between 0 and 100),
  evolution_stage  smallint not null default 0 check (evolution_stage between 0 and 3),
  care_points      numeric(10,3) not null default 0,
  care_points_floor numeric(10,3) not null default 0,
  hatched          boolean not null default false,
  is_alive         boolean not null default true,
  is_sleeping      boolean not null default false,
  sleep_kind       public.sleep_kind,
  sleep_started_at timestamptz,
  last_fed         timestamptz not null default now(),
  last_washed      timestamptz not null default now(),
  last_petted      timestamptz not null default now(),
  last_interaction timestamptz not null default now(),
  -- Server-computed decay (plan §6): "current" stats are derived lazily from
  -- the stored values + last_decay_tick; no client needs to tick 24/7.
  last_decay_tick  timestamptz not null default now(),
  birth_date       timestamptz not null default now(),
  feed_count       integer not null default 0,
  wash_count       integer not null default 0,
  pet_count        integer not null default 0,
  throw_ball_count integer not null default 0,
  overfeed_count   integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (user_id, pet_type)
);

-- Leaderboards become a plain indexed ORDER BY instead of the old
-- fetch-all-users-then-sort-client-side pattern.
create index pets_care_points_idx on public.pets (care_points desc);
create index pets_user_idx on public.pets (user_id);

alter table public.pets enable row level security;

create policy "pets: owner full access"
  on public.pets for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "pets: shared-group members read"
  on public.pets for select
  using (public.shares_group_with(user_id));

-- ── Quest progress (current cycle only) & reward history ────────────────────
create table public.pet_quest_progress (
  pet_id      uuid primary key references public.pets (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  day_key     text not null,
  week_key    text not null,
  daily       jsonb not null default '{}'::jsonb,
  weekly      jsonb not null default '{}'::jsonb,
  completion_counts jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

alter table public.pet_quest_progress enable row level security;

create policy "quest progress: owner full access"
  on public.pet_quest_progress for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Append-only, replaces the client-capped embedded rewardHistory array.
create table public.quest_reward_history (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  pet_id          uuid not null references public.pets (id) on delete cascade,
  quest_code      text not null,
  scope           text not null check (scope in ('daily', 'weekly')),
  period_key      text not null,
  status_at_close text not null check (status_at_close in ('claimed', 'expired')),
  awarded_points  numeric(8,3) not null default 0,
  discarded_points numeric(8,3) not null default 0,
  completed_at    timestamptz,
  claimed_at      timestamptz,
  expired_at      timestamptz,
  created_at      timestamptz not null default now()
);

create index quest_reward_history_user_idx on public.quest_reward_history (user_id, created_at desc);

alter table public.quest_reward_history enable row level security;

create policy "reward history: owner reads"
  on public.quest_reward_history for select
  using (auth.uid() = user_id);

create policy "reward history: owner appends"
  on public.quest_reward_history for insert
  with check (auth.uid() = user_id);
-- no update/delete policies: append-only for clients.

-- ── Achievements ────────────────────────────────────────────────────────────
create table public.achievements (
  user_id          uuid not null references public.profiles (id) on delete cascade,
  achievement_code text not null,
  status           public.achievement_status not null default 'claimable',
  earned_at        timestamptz not null default now(),
  claimed_at       timestamptz,
  primary key (user_id, achievement_code)
);

alter table public.achievements enable row level security;

create policy "achievements: owner full access"
  on public.achievements for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "achievements: shared-group members read"
  on public.achievements for select
  using (public.shares_group_with(user_id));

-- ── Hall of fame ────────────────────────────────────────────────────────────
-- Real UNIQUE constraint + INSERT ... ON CONFLICT DO NOTHING fixes the old
-- RestHeart check-then-create race (plan §3). group_id null = Global scope,
-- so "first Final evolution in Acme" and "…globally" are claimable separately.
create table public.hall_of_fame (
  id            uuid primary key default gen_random_uuid(),
  milestone_key text not null,
  group_id      uuid references public.groups (id) on delete cascade,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  pet_type      public.pet_type,
  claimed_at    timestamptz not null default now()
);

-- Postgres UNIQUE treats NULLs as distinct — use coalesce so the Global scope
-- (null group_id) is also unique per milestone.
create unique index hall_of_fame_unique_claim
  on public.hall_of_fame (milestone_key, coalesce(group_id, '00000000-0000-0000-0000-000000000000'::uuid));

alter table public.hall_of_fame enable row level security;

create policy "hall of fame: group members read"
  on public.hall_of_fame for select
  using (group_id is null or public.is_group_member(group_id));

create policy "hall of fame: claim own milestone"
  on public.hall_of_fame for insert
  with check (
    auth.uid() = user_id
    and (group_id is null or public.is_group_member(group_id))
  );

-- ── Friends ─────────────────────────────────────────────────────────────────
create table public.friends (
  requester_id uuid not null references public.profiles (id) on delete cascade,
  addressee_id uuid not null references public.profiles (id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at   timestamptz not null default now(),
  responded_at timestamptz,
  primary key (requester_id, addressee_id),
  check (requester_id <> addressee_id)
);

alter table public.friends enable row level security;

create policy "friends: parties read"
  on public.friends for select
  using (auth.uid() in (requester_id, addressee_id));

create policy "friends: request within shared group"
  on public.friends for insert
  with check (auth.uid() = requester_id and public.shares_group_with(addressee_id));

create policy "friends: addressee responds"
  on public.friends for update
  using (auth.uid() = addressee_id)
  with check (auth.uid() = addressee_id);

create policy "friends: either side removes"
  on public.friends for delete
  using (auth.uid() in (requester_id, addressee_id));

-- ── Session leases (plan §12) ───────────────────────────────────────────────
-- Exactly one live client instance per user. Managed EXCLUSIVELY by the
-- acquire/heartbeat/release Edge Functions (service role) — clients may only
-- READ their own lease. Server-side timestamps only.
create table public.pet_session_leases (
  user_id           uuid primary key references public.profiles (id) on delete cascade,
  session_id        uuid not null,
  device_type       public.device_type not null,
  acquired_at       timestamptz not null default now(),
  last_heartbeat_at timestamptz not null default now(),
  expires_at        timestamptz not null
);

alter table public.pet_session_leases enable row level security;

create policy "leases: owner reads"
  on public.pet_session_leases for select
  using (auth.uid() = user_id);
-- no insert/update/delete policies: Edge Functions only.

-- ── Licenses (plan §13) ─────────────────────────────────────────────────────
-- Server-enforced; written only by Edge Functions / Stripe webhooks / manual
-- admin inserts (beta grants). Clients may only read licenses that cover them.
create table public.licenses (
  id             uuid primary key default gen_random_uuid(),
  owner_user_id  uuid references public.profiles (id) on delete cascade,
  owner_group_id uuid references public.groups (id) on delete cascade,
  plan_type      public.plan_type not null,
  seat_count     integer not null default 1 check (seat_count >= 1),
  status         public.license_status not null default 'active',
  started_at     timestamptz not null default now(),
  renews_at      timestamptz,
  canceled_at    timestamptz,
  check (num_nonnulls(owner_user_id, owner_group_id) = 1)
);

create table public.license_activations (
  id           uuid primary key default gen_random_uuid(),
  license_id   uuid not null references public.licenses (id) on delete cascade,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  device_type  public.device_type not null,
  device_token text not null,
  activated_at timestamptz not null default now(),
  revoked_at   timestamptz,
  unique (license_id, user_id, device_token)
);

alter table public.licenses enable row level security;
alter table public.license_activations enable row level security;

create policy "licenses: covered users read"
  on public.licenses for select
  using (
    owner_user_id = auth.uid()
    or (owner_group_id is not null and public.is_group_member(owner_group_id))
  );

create policy "activations: owner reads"
  on public.license_activations for select
  using (auth.uid() = user_id);
-- no client write policies on licenses/activations: Edge Functions only.

-- ── Signup trigger: profile + Global membership ─────────────────────────────
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, name)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', '')
  );
  insert into public.group_memberships (user_id, group_id, role)
  values (new.id, '00000000-0000-0000-0000-000000000001', 'member');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── updated_at maintenance ──────────────────────────────────────────────────
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger pets_touch_updated_at
  before update on public.pets
  for each row execute function public.touch_updated_at();

create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

create trigger quest_progress_touch_updated_at
  before update on public.pet_quest_progress
  for each row execute function public.touch_updated_at();
