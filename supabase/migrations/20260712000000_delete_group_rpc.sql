-- ============================================================================
-- delete_group RPC
--
-- The RLS policy "groups: owner deletes (never global)" (foundation
-- migration) already allows the owner to delete a group row directly, and
-- group_memberships/hall_of_fame both reference groups(id) on delete cascade
-- so a plain delete leaves no orphaned rows. This RPC exists to give the
-- client a single clean call with explicit error messages (not found / not
-- owner / global group) rather than relying on a raw delete silently
-- affecting 0 rows when RLS blocks it.
--
-- Future work (not implemented here): group_type already has an
-- 'organization' variant reserved for org-created rooms, but create_group
-- hardcodes 'friend_circle' and there's no insert policy or RPC allowing a
-- client to create an 'organization' group. That needs its own
-- authorization check (e.g. against licenses/license_activations) before
-- it can be exposed.
-- ============================================================================

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
