---
name: pet-game-backend
description: >
  Exact Supabase schema, RLS policies, Postgres RPCs, Edge Functions, and
  client-DB mapping for my_pet_companion — tables, columns, policies, and
  functions by name, from supabase/migrations/*.sql and
  supabase/functions/**. USE THIS SKILL whenever the task touches: adding or
  changing a Supabase table/column/RLS policy, writing a new Postgres RPC or
  Edge Function, debugging a "permission denied for table X (42501)" or RLS
  access error, the session-lease/single-device-login system, group/
  membership writes, leaderboard/hall-of-fame/achievement visibility across
  users, applying or writing a new migration, or anything involving
  `supabase.rpc(...)`, `supabase.from(...)`, or the service-role vs anon-key
  boundary in this repo.
---

# Supabase backend (schema / RLS / RPCs / Edge Functions)

Migrations live in `supabase/migrations/`, applied in filename order:
`20260709120000_foundation.sql` → `20260709130000_grants.sql` →
`20260710100000_social_reads.sql` → `20260711000000_group_rpcs.sql`. Apply
via `supabase db push` after `supabase link --project-ref
uzeanduiaeeymdqdzuuc` (see `supabase/README.md` for the full CLI/dashboard
workflow and the post-apply RLS verification checklist — run that checklist
after any RLS change, it's short and catches cross-user leaks fast).

**Every table has RLS enabled and a matching baseline GRANT.** Postgres
checks the outer `GRANT` before RLS is even consulted — a correct RLS
policy with a missing `authenticated` grant still fails with `permission
denied for table X (42501)`. If you add a table, add BOTH: a policy in the
same or a new migration, AND a grant (mirror the pattern in
`20260709130000_grants.sql`).

## Tables

| Table | Purpose | Key columns |
|---|---|---|
| `profiles` | mirrors `auth.users`, display name | `id` (PK, → `auth.users.id`), `email`, `name` |
| `groups` | friend circles + the singleton Global group | `id`, `name`, `group_type` (`organization\|friend_circle\|custom\|global`), `owner_id`, `invite_code` unique |
| `group_memberships` | who's in what group | composite PK `(user_id, group_id)`, `role` (`owner\|admin\|member`) |
| `pets` | one row per user × pet_type — the actual save data | `id`, `user_id`, `pet_type` (`cat\|dog\|dino\|dragon\|ghost\|robot\|phoenix`), stats (`hunger/warmth/cleanliness/happiness` numeric 0-100), `evolution_stage` (0-3), `care_points`, `care_points_floor`, `hatched`, `is_alive`, `is_sleeping`, `sleep_kind`, timestamps (`last_fed/last_washed/last_petted/last_interaction/last_decay_tick/birth_date`), counters (`feed_count/wash_count/pet_count/throw_ball_count/overfeed_count`). `unique(user_id, pet_type)`. Indexed on `care_points desc` (leaderboard) and `user_id`. |
| `pet_quest_progress` | quest state | PK `pet_id`, `day_key`, `week_key`, `daily jsonb`, `weekly jsonb`, `completion_counts jsonb` |
| `quest_reward_history` | append-only claim/expiry log | `quest_code`, `scope` (`daily\|weekly`), `period_key`, `status_at_close` (`claimed\|expired`), `awarded_points`, `discarded_points` |
| `achievements` | composite PK `(user_id, achievement_code)` | `status` (`claimable\|claimed`), `earned_at`, `claimed_at` |
| `hall_of_fame` | first-come permanent milestone claims | `milestone_key`, `group_id` (null = Global scope), `user_id`, `pet_type`. Unique index on `(milestone_key, coalesce(group_id, zero-uuid))` — lets a per-group AND a global claim of the same milestone key coexist, since Postgres treats NULL as distinct by default otherwise. Client inserts use `ON CONFLICT DO NOTHING`. |
| `friends` | composite PK `(requester_id, addressee_id)`, `status` (`pending\|accepted\|declined`) | not yet wired to any UI — DB supports it, no frontend exists |
| `pet_session_leases` | single-active-device enforcement | PK `user_id`, `session_id`, `device_type`, `acquired_at`, `last_heartbeat_at`, `expires_at`. **Edge-Function-only writes** — clients only get `select`. |
| `licenses` / `license_activations` | billing/seat scaffolding, not actively used yet | read-only for covered users; service-role-only writes |

Global group is a seeded singleton row: `id =
'00000000-0000-0000-0000-000000000001'`, `group_type='global'` — every user
auto-joins it via the signup trigger (see below), never created client-side.

## RLS policy patterns (the shapes to copy for a new table)

- **Owner-only CRUD**: `pets`, `pet_quest_progress`, `achievements` —
  `auth.uid() = user_id` on `all` (or split select/insert/update/delete
  identically).
- **Shared-group visibility**: `pets`, `profiles`, `achievements` all also
  have a `select` policy using `shares_group_with(user_id)` — this is what
  makes leaderboards and hall-of-fame able to show OTHER users' names/pets/
  achievements, scoped to "anyone you share a group with" rather than
  "everyone." Added in `social_reads.sql` after the initial foundation
  migration shipped leaderboards with no visible names.
- **Append-only**: `quest_reward_history` has `select` + `insert` policies
  and grants, but deliberately **no update/delete policy or grant** — once
  written, a history row is immutable.
- **RPC-gated writes**: `group_memberships` has **no client insert policy
  at all** — only `select` (own + same-group) and a `delete` (owner-removes
  or self-leave). Membership creation is intentionally forced through the
  `create_group`/`join_group` SECURITY DEFINER functions below, so
  membership writes are server-validated (invite-code lookup, name
  validation) rather than trusting arbitrary client inserts.
- **First-claim races**: `hall_of_fame`'s unique index + `ON CONFLICT DO
  NOTHING` from the client is the whole mechanism — no RPC needed, Postgres
  just makes the loser's insert a silent no-op.
- **Service-role-only**: `pet_session_leases`, `licenses`,
  `license_activations` — `authenticated` gets `select` only (or nothing);
  all writes go through Edge Functions using the service-role key, which
  bypasses RLS entirely. Use this pattern for anything where the CLIENT
  must never be trusted to write the field itself (session leases, billing
  state).

## Postgres RPCs (`supabase.rpc(...)` from the client)

- **`create_group(group_name text) → groups`** — `SECURITY DEFINER`.
  Validates name (2-40 chars), generates a 6-char invite code from
  `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no `0/O/1/I` — avoids ambiguity read
  aloud), retries up to 5× on collision, inserts the group with
  `owner_id = auth.uid()`, then inserts the caller into
  `group_memberships` as `role='owner'`. Called from
  `useGroups.ts`.
- **`join_group(code text) → groups`** — `SECURITY DEFINER`. Looks up
  `groups` by `invite_code = upper(trim(code))` (excluding
  `group_type='global'`), raises `'invalid invite code'` if not found,
  inserts membership `on conflict (user_id, group_id) do nothing`
  (idempotent — re-joining is a no-op, not an error). Called from
  `useGroups.ts`.
- **`shares_group_with(other uuid) → boolean`** / **`is_group_member(gid
  uuid) → boolean`** — both `SECURITY DEFINER`, `stable`, used ONLY inside
  RLS `using` clauses (never called directly via `.rpc()`). Written as
  definer functions specifically to avoid the classic recursive-RLS-policy
  trap (a `group_memberships` policy that queries `group_memberships`
  inside itself).

- **`delete_group(target_group_id uuid) → void`** (migration
  `20260712000000`) — `SECURITY DEFINER`. Owner-only, never the Global
  group; a plain hard delete (memberships + group-scoped hall_of_fame rows
  cascade). Called from `useGroups.ts`'s `deleteGroup` (returns boolean
  success to the UI so history logging can be gated on it).
- **`record_minigame_result(p_game_code text, p_distance numeric, p_won
  boolean) → void`** (migration `20260713010000`) — `SECURITY INVOKER`
  (only touches the caller's own row). Atomic upsert into
  `minigame_scores` (PK `(user_id, game_code)`: `best_score = least(...)`,
  `games_played + 1`, conditional `games_won`). Game codes so far: `'rps'`
  (p_distance null), `'target_toss'` (p_distance = best throw distance,
  lower = better). Each participant's OWN client calls it once on game
  over. **Minigames grant no progression rewards** — this table exists for
  future achievements/leaderboards only.

Both `create_group`/`join_group` are `grant execute ... to authenticated`.
If you add a new client-callable RPC that needs to bypass an intentionally
restrictive table policy (like `group_memberships`'s missing insert
policy), follow this exact shape: `SECURITY DEFINER`, `set search_path =
public`, validate inputs explicitly (don't trust the RPC's own privilege
escalation to substitute for input validation), grant execute to
`authenticated`.

Schema additions (Jul 2026): `pets.egg_chosen boolean default true`
(migration `20260712010000` — false only for genuinely fresh saves, gates
the first-launch egg picker); `minigame_scores` table (see RPC above, RLS:
owner-or-shared-group read, owner insert/update). Migration `20260713000000`
(hardening, from `supabase db advisors`): revoked `anon` EXECUTE on all the
SECURITY DEFINER group RPCs + helpers and pinned `touch_updated_at`'s
search_path. Deferred advisor items (perf-at-scale lint only):
`auth_rls_initplan` and `multiple_permissive_policies`. The Supabase CLI is
now linked on this machine — `npx supabase migration list --linked` /
`db query --linked -f file.sql` work; `db push` needs the user's go-ahead.

## Edge Functions (`supabase/functions/`, Deno) — the session-lease system

Enforces "only one active device per account." `_shared/lease.ts`:
`HEARTBEAT_INTERVAL_MS = 20_000`, `LEASE_TTL_MS = 75_000` (~3.75× the
heartbeat interval, tolerating a few missed beats before treating a session
as dead). `_shared/authClient.ts` provides `serviceClient()` (service-role,
bypasses RLS — Edge Functions are the only place this key exists) and
`getAuthedUser(req)` (validates the `Authorization` header against the
anon-key client).

- **`acquire-session`** — POST `{ sessionId, deviceType, force? }`. Reads
  the caller's existing lease row; if it exists, is unexpired, belongs to a
  *different* `session_id`, and `force` isn't set → returns `{ granted:
  false, conflict: { deviceType, acquiredAt } }` (this is what
  `useSessionLease.ts`'s `LeaseConflict` UI surfaces — "another device is
  active, force takeover?"). Otherwise upserts the lease with a fresh
  `expires_at = now + LEASE_TTL_MS` and returns `{ granted: true,
  expiresAt, heartbeatIntervalMs }`.
- **`heartbeat-session`** — POST `{ sessionId }`, called every
  `HEARTBEAT_INTERVAL_MS` while active. If the stored `session_id` doesn't
  match (another device took over) → `{ ok: false, reason: "not_owner" }`,
  which the client treats as "you've been signed out elsewhere." Otherwise
  bumps `expires_at`.
- **`release-session`** — POST `{ sessionId? }`, called on clean sign-out.
  Deletes the lease row, filtered by BOTH `user_id` AND `session_id` if
  provided — this ordering matters: it means a delayed/late release call
  from an OLD session can never delete a session that took over afterward.

If you touch this flow, keep the "filter delete by session_id" detail —
it's the one thing preventing a race where signing out an old tab could
kick a device that legitimately took over via force-takeover.

## Client wiring

- `apps/desktop/src/supabase/client.ts` — reads `VITE_SUPABASE_URL` +
  `VITE_SUPABASE_PUBLISHABLE_KEY` (anon key only, **never** the service
  key — that only exists inside Edge Functions).
  `detectSessionInUrl: false` (Electron has no OAuth redirect URL to
  parse). A code comment flags a known follow-up: auth tokens currently
  persist in renderer `localStorage` and should move to Electron's
  `safeStorage`/OS keychain before a real public release — worth doing
  before wide distribution, not urgent for a QA build.
- `apps/desktop/src/supabase/petRow.ts` — `saveToRow`/`rowToSave` do a
  clean 1:1 camelCase↔snake_case field mapping (e.g. `carePoints` ↔
  `care_points`, `evolutionStage` ↔ `evolution_stage`) — no semantic
  renames to trip over. The one non-obvious bit: `rowToSave` explicitly
  `Number(...)`-coerces the numeric-typed columns (`hunger`, `warmth`,
  `cleanliness`, `happiness`, `care_points`, `care_points_floor`) because
  PostgREST serializes Postgres `numeric` columns as JSON strings, not
  numbers — if you add a new numeric column, remember this coercion or
  you'll get silent string-concatenation bugs instead of arithmetic
  further up the stack.
