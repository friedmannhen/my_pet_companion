-- Poop cleanup counter (Jul 2026 plan, Phase 0). Mirrors the other lifetime
-- counters (feed_count/wash_count/...) exactly: a plain integer column on
-- pets, synced through the same row upsert every other counter already
-- rides — no new grants or policies needed (the table-level GRANT in
-- 20260709130000_grants.sql covers new columns). Future achievements/
-- statistics will key off this, which is why it's cloud-synced from day one.

alter table public.pets
  add column if not exists poop_cleaned_count integer not null default 0;
