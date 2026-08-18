-- FPL Tracker — cross-device draft sync
-- Run this once in the Supabase SQL editor for project gwemacdcdpeuajhjhamc.
--
-- There is deliberately NO sign-in. That has a consequence worth stating
-- plainly: this repo is public, so the anon key in the deployed JavaScript is
-- public too, and anyone who reads it can read and write the row below. For a
-- personal draft board that is an acceptable trade for never signing in — but
-- it is not private, so never put anything sensitive here.
--
-- The blast radius is limited two ways: the policies below allow access to one
-- fixed row id and nothing else, and the table holds only a pick log.

create table if not exists public.draft_state (
  id          text primary key,
  state       jsonb       not null,
  updated_at  timestamptz not null default now(),
  device      text
);

alter table public.draft_state enable row level security;

-- Scoped to the single known board. Without the id predicate the anon key
-- could create or overwrite arbitrary rows in this table.
drop policy if exists "read the shared board"   on public.draft_state;
drop policy if exists "create the shared board" on public.draft_state;
drop policy if exists "update the shared board" on public.draft_state;

create policy "read the shared board" on public.draft_state
  for select to anon
  using (id = 'fpl-2627-draft');

create policy "create the shared board" on public.draft_state
  for insert to anon
  with check (id = 'fpl-2627-draft');

create policy "update the shared board" on public.draft_state
  for update to anon
  using (id = 'fpl-2627-draft')
  with check (id = 'fpl-2627-draft');

-- Keep updated_at honest: the client compares it to decide which device holds
-- the newer draft, so it must not be settable by the client.
create or replace function public.touch_draft_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists draft_state_touch on public.draft_state;
create trigger draft_state_touch
  before insert or update on public.draft_state
  for each row execute function public.touch_draft_state();
