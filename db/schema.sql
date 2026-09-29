-- Full current schema (state after every file in db/ has been applied).
-- For a fresh Supabase project run this file alone instead of the dated
-- migrations. Keep it in sync whenever a new migration is added.

create extension if not exists "pgcrypto";

-- Workspaces: independent task buckets (header tabs).

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  position int not null default 0,
  created_at timestamptz not null default now(),
  is_default boolean not null default false,
  constraint workspaces_id_user_unique unique (id, user_id)
);

create index if not exists workspaces_user_idx
  on public.workspaces (user_id);
create index if not exists workspaces_user_position_idx
  on public.workspaces (user_id, position);
create unique index if not exists workspaces_one_default_per_user_idx
  on public.workspaces (user_id)
  where is_default;

alter table public.workspaces enable row level security;

create policy "workspaces_select_own" on public.workspaces
  for select using (auth.uid() = user_id);
create policy "workspaces_insert_own" on public.workspaces
  for insert with check (auth.uid() = user_id);
create policy "workspaces_update_own" on public.workspaces
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "workspaces_delete_own" on public.workspaces
  for delete using (auth.uid() = user_id);

-- The default workspace cannot be deleted while its owner exists.
create or replace function public.prevent_default_workspace_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.is_default then
    if exists (select 1 from auth.users u where u.id = old.user_id) then
      raise exception 'Cannot delete default workspace';
    end if;
  end if;
  return old;
end;
$$;

create trigger workspaces_prevent_default_delete
  before delete on public.workspaces
  for each row
  execute function public.prevent_default_workspace_delete();

-- Tasks: `general` rows are the week's inbox (date = that week's Monday);
-- `daily` rows belong to a day column (day_name + that day's date).

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid,
  type text not null check (type in ('general', 'daily')),
  day_name text,
  date date not null,
  content text not null default '',
  completed boolean not null default false,
  is_subtask boolean not null default false,
  is_main boolean not null default false,
  color text,
  position int not null default 0,
  created_at timestamptz default now(),
  constraint tasks_workspace_user_fkey
    foreign key (workspace_id, user_id)
    references public.workspaces (id, user_id)
    on delete cascade
);

create index if not exists tasks_user_workspace_idx
  on public.tasks (user_id, workspace_id);
create index if not exists tasks_list_order_idx
  on public.tasks (user_id, type, date, day_name, workspace_id, position);
-- This week's main thing: at most one per user/workspace/week.
create unique index if not exists tasks_one_main_thing_idx
  on public.tasks (user_id, workspace_id, date)
  where type = 'general'
    and is_main = true
    and coalesce(is_subtask, false) = false;

alter table public.tasks enable row level security;

create policy "Users can view own tasks" on public.tasks
  for select using (auth.uid() = user_id);
create policy "Users can insert own tasks" on public.tasks
  for insert with check (auth.uid() = user_id);
create policy "Users can update own tasks" on public.tasks
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users can delete own tasks" on public.tasks
  for delete using (auth.uid() = user_id);

-- Per-account settings synced across devices (currently: themes).

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  theme_selected text,
  custom_themes jsonb not null default '[]'::jsonb,
  theme_updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;

create policy "user_settings_select_own" on public.user_settings
  for select using (auth.uid() = user_id);
create policy "user_settings_insert_own" on public.user_settings
  for insert with check (auth.uid() = user_id);
create policy "user_settings_update_own" on public.user_settings
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
