-- ============================================================================
-- DEV-PHASE SHEET — paste into the Supabase SQL editor and run top to bottom.
-- (Or run each section separately; every statement is idempotent/safe to
-- re-run.) Last updated: 2026-07-14.
--
-- NOTE: the CLI is linked now — `npx supabase db push` is the preferred way
-- to apply migrations (Section 0 mirrors migrations that are ALREADY applied
-- to the live DB as of 2026-07-13; it stays here only because it's harmless
-- to re-run). Newer pending migrations (harden_functions, minigame_scores)
-- are NOT mirrored here — use db push for those.
-- Section 1 wipes dev-phase garbage data. Section 2 (commented out) nukes
-- specific test accounts entirely.
--
-- NOTE after running Section 1: any dev machine that still has a local save
-- cached will re-seed its cloud row from that cache on next launch (that's
-- the offline-cache-as-seed design working as intended). To fully reset a
-- machine, also use the in-app admin full reset (or clear localStorage).
-- ============================================================================


-- ── Section 0: pending migrations ───────────────────────────────────────────
-- 0a. delete_group RPC (mirror of migrations/20260712000000_delete_group_rpc.sql)

create or replace function public.delete_group(target_group_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  g public.groups;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select * into g from groups where id = target_group_id;
  if g.id is null then
    raise exception 'group not found';
  end if;
  if g.group_type = 'global' then
    raise exception 'cannot delete the global group';
  end if;
  if g.owner_id is distinct from auth.uid() then
    raise exception 'only the owner can delete this group';
  end if;

  delete from groups where id = target_group_id; -- memberships/hall_of_fame cascade
end;
$$;

grant execute on function public.delete_group(uuid) to authenticated;

-- 0b. egg_chosen column (mirror of migrations/20260712010000_egg_chosen.sql).
-- Existing rows default to true (those players already have a pet in
-- progress) — only genuinely fresh rows are inserted with false.

alter table public.pets
  add column if not exists egg_chosen boolean not null default true;

-- Ask PostgREST to reload its schema cache immediately (otherwise the
-- PGRST204 error can linger a bit even after the column exists).
notify pgrst, 'reload schema';


-- ── Section 1: dev data cleanup ─────────────────────────────────────────────
-- Order matters only where noted; most child rows cascade from their parent.

-- 1a. All user-created rooms (keeps only the Global group).
--     Cascades: group_memberships of those groups, group-scoped hall_of_fame.
delete from public.groups where group_type <> 'global';

-- 1b. Hall of fame — global-scope milestones too (so "first final evolution"
--     is claimable again after pets are reset).
delete from public.hall_of_fame;

-- 1c. Quest reward audit log.
delete from public.quest_reward_history;

-- 1d. Account-wide achievements (claimed bonuses reset).
delete from public.achievements;

-- 1e. Friend links (feature not fully wired yet — clear any test rows).
delete from public.friends;

-- 1f. Single-device session leases (stale leases can block sign-ins).
delete from public.pet_session_leases;

-- 1g. Pets — cascades pet_quest_progress. Every account re-seeds a fresh
--     egg (with the egg picker, egg_chosen=false comes from the client's
--     fresh save) on its next sign-in.
delete from public.pets;

-- Profiles, auth.users and Global-group memberships are intentionally KEPT —
-- accounts stay usable, only progression/social data is wiped.


-- ── Section 2 (OPTIONAL, commented out): delete whole test accounts ─────────
-- Deleting from auth.users cascades profiles → memberships → everything.
-- Uncomment and edit the email list only when you really mean it.
--
-- delete from auth.users
-- where email in (
--   'chuplie@gmail.com'
-- );
