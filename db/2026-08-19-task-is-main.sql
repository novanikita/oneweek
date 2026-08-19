-- This week's main thing: at most one general task per user/workspace/week.
-- Run once in Supabase → SQL Editor. Safe to re-run.

alter table public.tasks
  add column if not exists is_main boolean not null default false;

-- If a previous partial run left more than one main row, keep the earliest.
with ranked as (
  select
    id,
    row_number() over (
      partition by user_id, workspace_id, date
      order by position asc, created_at asc
    ) as rn
  from public.tasks
  where type = 'general'
    and is_main = true
    and coalesce(is_subtask, false) = false
)
update public.tasks t
set is_main = false
from ranked
where t.id = ranked.id
  and ranked.rn > 1;

create unique index if not exists tasks_one_main_thing_idx
  on public.tasks (user_id, workspace_id, date)
  where type = 'general'
    and is_main = true
    and coalesce(is_subtask, false) = false;
