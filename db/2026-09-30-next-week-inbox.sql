-- "Next week" column → next week's task list.
-- The column now shows the `general` list of the following week, so its old
-- rows (type = 'daily', day_name = 'Next week', date = that week's Monday)
-- become regular week-list rows of that week, appended after its tasks.
--
-- Run once in Supabase → SQL Editor AFTER deploying the app version that
-- reads the column this way. Safe to re-run (e.g. if a tab still running the
-- old version adds more rows): each run moves whatever is left.

begin;

with week_tail as (
  select user_id, workspace_id, date, max(position) as max_pos
  from public.tasks
  where type = 'general'
  group by user_id, workspace_id, date
),
moved as (
  select
    t.id,
    row_number() over (
      partition by t.user_id, t.workspace_id, t.date
      order by t.position, t.created_at, t.id
    ) as rn,
    coalesce(w.max_pos, -1) as base
  from public.tasks t
  left join week_tail w
    on w.user_id = t.user_id
   and w.workspace_id is not distinct from t.workspace_id
   and w.date = t.date
  where t.type = 'daily'
    and t.day_name = 'Next week'
)
update public.tasks t
set
  type = 'general',
  day_name = null,
  is_main = false,
  -- The first moved row must not start with a subtask: appended after the
  -- week's tasks it would otherwise nest under someone else's task.
  is_subtask = case when m.rn = 1 then false else t.is_subtask end,
  position = m.base + m.rn
from moved m
where t.id = m.id;

commit;
