-- Hardening pass driven by `supabase db advisors` findings (2026-07-13):
--
-- 1) SECURITY DEFINER functions were executable by `anon` (PostgREST exposes
--    them at /rest/v1/rpc/*). Each one already guards with `auth.uid() is
--    null → raise`, so this closes belt-and-suspenders surface rather than a
--    live exploit — but there's no reason an unauthenticated caller should
--    be able to invoke them at all.
-- 2) `touch_updated_at` had a role-mutable search_path (advisor
--    function_search_path_mutable) — pin it.
--
-- Remaining advisor WARNs deliberately deferred (perf lint, not security):
-- auth_rls_initplan (wrap auth.uid() in (select ...) inside policies) and
-- multiple_permissive_policies — both only matter at row-count scale this
-- dev-phase app is nowhere near; fold them into a later policy tidy-up.

revoke execute on function public.create_group(text) from anon;
revoke execute on function public.join_group(text) from anon;
revoke execute on function public.delete_group(uuid) from anon;
revoke execute on function public.is_group_member(uuid) from anon;
revoke execute on function public.shares_group_with(uuid) from anon;
-- handle_new_user is a trigger function — nothing should call it directly.
revoke execute on function public.handle_new_user() from anon, authenticated;

alter function public.touch_updated_at() set search_path = public;
