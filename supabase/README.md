# Supabase backend

Project: `https://uzeanduiaeeymdqdzuuc.supabase.co`

## Applying migrations

Option A — Supabase Dashboard (quickest, no CLI):
1. Open the project's **SQL Editor**.
2. Paste the contents of each file in `migrations/` in filename order and run it.

Option B — Supabase CLI (repeatable, preferred once set up):
```sh
npm i -g supabase
supabase login                 # needs your personal access token
supabase link --project-ref uzeanduiaeeymdqdzuuc
supabase db push               # applies migrations/ in order
```

## Verification after applying (plan §18, Phase 1)

- Sign in with two test accounts; confirm user A **cannot** select or update
  user B's `pets` row from the client (RLS), while each user can read/write
  their own.
- Confirm a new signup automatically gets a `profiles` row and a Global
  `group_memberships` row (signup trigger).
- Confirm inserting the same `hall_of_fame` (milestone_key, group_id) twice
  fails the unique index (`ON CONFLICT DO NOTHING` path).
- Confirm clients cannot insert/update `pet_session_leases`, `licenses`, or
  `license_activations` (Edge-Function-only tables).

## Security invariants

- The **service-role key** is only ever used by Edge Functions / server-side
  tooling. It must never appear in any client bundle or this repo.
- Clients use the publishable key; every table has RLS enabled.
