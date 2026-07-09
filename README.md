# My Pet Companion

Windows-first desktop virtual pet companion for the 5-day work week. The pet lives in a transparent, click-through, always-on-top overlay roaming the real desktop.

**Proprietary — all rights reserved.** Private repo, not open source.

## Layout

- `apps/desktop` — Electron + React 19 desktop app (flagship client)
- `packages/pet-core` — framework-agnostic game logic (rules, decay, quests, achievements), shared by clients and Supabase Edge Functions
- `supabase/` — Postgres migrations + Edge Functions (backend authority)

## Dev

```sh
pnpm install
pnpm dev:desktop
```

Master plan: `PET_GAME_TRANSFORMATION_PLAN.md` in the ERP_QA_HUB repo (source of the ported pet-widget logic).
