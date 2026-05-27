-- Task list ordering (syncs drag-and-drop order across devices).
-- Run once in Supabase → SQL Editor. Safe to re-run.

alter table public.tasks
  add column if not exists position int not null default 0;

-- Backfill: unchecked first, then created_at (matches the app’s list rules).
with ranked as (
  select
    id,
    (row_number() over (
      partition by
        user_id,
        type,
        coalesce(date::text, ''),
        coalesce(day_name, ''),
        coalesce(workspace_id::text, '')
      order by completed asc, created_at asc
    ) - 1)::int as pos
  from public.tasks
)
update public.tasks t
set position = ranked.pos
from ranked
where t.id = ranked.id;

create index if not exists tasks_list_order_idx
  on public.tasks (
    user_id,
    type,
    date,
    day_name,
    workspace_id,
    position
  );
