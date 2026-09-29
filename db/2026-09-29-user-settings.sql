-- Per-account settings synced across devices (currently: themes).
-- Run once in Supabase → SQL Editor. Safe to re-run.

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- Preset key, `auto`, or `custom:<id>`; null while a device was mid-edit
  -- in the "Own..." theme editor.
  theme_selected text,
  -- [{ id, name, text, bg, fontId }]
  custom_themes jsonb not null default '[]'::jsonb,
  -- Client time of the last theme change; the newer device wins.
  theme_updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;

drop policy if exists "user_settings_select_own" on public.user_settings;
drop policy if exists "user_settings_insert_own" on public.user_settings;
drop policy if exists "user_settings_update_own" on public.user_settings;

create policy "user_settings_select_own" on public.user_settings
  for select using (auth.uid() = user_id);
create policy "user_settings_insert_own" on public.user_settings
  for insert with check (auth.uid() = user_id);
create policy "user_settings_update_own" on public.user_settings
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
