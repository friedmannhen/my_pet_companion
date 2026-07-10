-- ============================================================================
-- Group creation / joining RPCs (multiplayer phase 1)
--
-- group_memberships deliberately has NO client INSERT policy (foundation
-- migration: memberships are written by the signup trigger or server code
-- only). Creating a friend circle and joining by invite code are therefore
-- SECURITY DEFINER functions: they validate everything server-side and do
-- the two-table writes atomically, without opening memberships to arbitrary
-- client inserts.
-- ============================================================================

-- Creates a friend-circle group owned by the caller, with a fresh 6-char
-- invite code, and joins the caller as owner. Returns the new group row.
create or replace function public.create_group(group_name text)
returns public.groups
language plpgsql
security definer
set search_path = public
as $$
declare
  g public.groups;
  attempts int := 0;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if length(trim(group_name)) < 2 or length(trim(group_name)) > 40 then
    raise exception 'group name must be 2-40 characters';
  end if;

  loop
    begin
      insert into groups (name, group_type, owner_id, invite_code)
      values (
        trim(group_name),
        'friend_circle',
        auth.uid(),
        -- 6 chars, unambiguous alphabet (no 0/O/1/I) for read-aloud codes.
        (
          select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', (random() * 31)::int + 1, 1), '')
          from generate_series(1, 6)
        )
      )
      returning * into g;
      exit;
    exception when unique_violation then
      attempts := attempts + 1;
      if attempts > 5 then
        raise exception 'could not generate a unique invite code';
      end if;
    end;
  end loop;

  insert into group_memberships (user_id, group_id, role)
  values (auth.uid(), g.id, 'owner');

  return g;
end;
$$;

-- Joins the caller to the group matching the invite code (idempotent).
-- Returns the group row so the client can show what was joined.
create or replace function public.join_group(code text)
returns public.groups
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

  select * into g
  from groups
  where invite_code = upper(trim(code))
    and group_type <> 'global';
  if g.id is null then
    raise exception 'invalid invite code';
  end if;

  insert into group_memberships (user_id, group_id, role)
  values (auth.uid(), g.id, 'member')
  on conflict (user_id, group_id) do nothing;

  return g;
end;
$$;

grant execute on function public.create_group(text) to authenticated;
grant execute on function public.join_group(text) to authenticated;
