-- ============================================================================
-- egg_chosen: first-launch starter-egg picker
--
-- New signups get a 3-egg picker before their pet exists (see EggSelect.tsx).
-- Existing rows default to true (their player already has a pet in
-- progress) so this never retroactively shows the picker to a returning
-- player. Only a genuinely fresh row (created via the seed-insert path in
-- usePetGame.ts, before the picker is completed) is inserted with false.
-- ============================================================================

-- "if not exists" so this stays safe if it was already applied manually via
-- the dashboard SQL editor before `supabase db push` runs.
alter table public.pets
  add column if not exists egg_chosen boolean not null default true;
