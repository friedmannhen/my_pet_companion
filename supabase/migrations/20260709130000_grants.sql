-- ============================================================================
-- Table/schema grants (Phase 1 follow-up)
--
-- RLS policies restrict WHICH ROWS a role can touch, but Postgres requires a
-- baseline GRANT before RLS is even consulted — without it every query fails
-- with "permission denied for table X (42501)" regardless of how correct the
-- RLS policies are. The foundation migration created tables/policies but
-- never granted table-level privileges to `authenticated`, so nothing could
-- be read or written. Grants below mirror exactly what each table's RLS
-- policies already allow (belt-and-suspenders: GRANT sets the outer
-- boundary, RLS narrows it further per-row).
-- ============================================================================

grant usage on schema public to authenticated, service_role;

-- profiles: read own, update own (insert is via the signup trigger only,
-- which runs as the trigger owner — not a client-role insert)
grant select, update on public.profiles to authenticated;

-- groups: full CRUD, RLS restricts to member-read / owner-write
grant select, insert, update, delete on public.groups to authenticated;

-- group_memberships: read (own + shared group), leave/owner-remove
grant select, delete on public.group_memberships to authenticated;

-- pets: full CRUD for the owner (RLS "for all"), shared-group read
grant select, insert, update, delete on public.pets to authenticated;

-- pet_quest_progress: full CRUD for the owner (RLS "for all")
grant select, insert, update, delete on public.pet_quest_progress to authenticated;

-- quest_reward_history: append-only (no update/delete policy exists)
grant select, insert on public.quest_reward_history to authenticated;

-- achievements: full CRUD for the owner, shared-group read
grant select, insert, update, delete on public.achievements to authenticated;

-- hall_of_fame: group-scoped read, claim (insert)
grant select, insert on public.hall_of_fame to authenticated;

-- friends: request/accept/decline/remove
grant select, insert, update, delete on public.friends to authenticated;

-- pet_session_leases: clients may only READ their own lease; Edge Functions
-- (service_role) own every write (acquire/heartbeat/release)
grant select on public.pet_session_leases to authenticated;
grant select, insert, update, delete on public.pet_session_leases to service_role;

-- licenses / license_activations: clients read-only; Edge Functions / Stripe
-- webhooks (service_role) own every write
grant select on public.licenses to authenticated;
grant select on public.license_activations to authenticated;
grant select, insert, update, delete on public.licenses to service_role;
grant select, insert, update, delete on public.license_activations to service_role;

-- security-definer helper functions invoked from inside RLS policies
grant execute on function public.shares_group_with(uuid) to authenticated;
grant execute on function public.is_group_member(uuid) to authenticated;
