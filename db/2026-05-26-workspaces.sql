-- One-time migration: add workspaces (multi-tab) support.
-- Apply once in the Supabase SQL editor. Safe to re-run.

create extension if not exists "pgcrypto";

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  position int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists workspaces_user_idx on public.workspaces(user_id);
create index if not exists workspaces_user_position_idx on public.workspaces(user_id, position);

alter table public.workspaces enable row level security;

drop policy if exists "workspaces_select_own" on public.workspaces;
drop policy if exists "workspaces_insert_own" on public.workspaces;
drop policy if exists "workspaces_update_own" on public.workspaces;
drop policy if exists "workspaces_delete_own" on public.workspaces;

create policy "workspaces_select_own" on public.workspaces
  for select using (auth.uid() = user_id);
create policy "workspaces_insert_own" on public.workspaces
  for insert with check (auth.uid() = user_id);
create policy "workspaces_update_own" on public.workspaces
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "workspaces_delete_own" on public.workspaces
  for delete using (auth.uid() = user_id);

alter table public.tasks
  add column if not exists workspace_id uuid references public.workspaces(id) on delete cascade;

create index if not exists tasks_user_workspace_idx
  on public.tasks(user_id, workspace_id);
