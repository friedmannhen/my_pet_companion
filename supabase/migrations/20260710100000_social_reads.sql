-- ============================================================================
-- Social reads (leaderboard / hall of fame display identities)
--
-- pets and achievements were already readable by shared-group members (and
-- everyone shares the singleton Global group), but profiles were owner-only —
-- so a leaderboard could rank everyone yet show no names. Mirror the same
-- shared-group read rule onto profiles.
-- ============================================================================

create policy "profiles: shared-group members read"
  on public.profiles for select
  using (public.shares_group_with(id));
