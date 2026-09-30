-- Tasks table cleanup: orphan rows, loose column definitions, unused
-- soft-delete column, missing user FK, and a default-workspace trigger that
-- blocked deleting users.
-- Run once in Supabase → SQL Editor. Runs in one transaction: if any step
-- fails, nothing is changed. Safe to re-run.

begin;

-- 1. Tasks created before workspaces existed whose owners never signed in
--    again (the client backfill only runs on login). Give each owner a
--    default workspace and attach the tasks to it.
insert into public.workspaces (user_id, name, position, is_default)
select distinct t.user_id, 'main', 0, true
from public.tasks t
where t.workspace_id is null
  and exists (select 1 from auth.users u where u.id = t.user_id)
  and not exists (select 1 from public.workspaces w where w.user_id = t.user_id);

update public.tasks t
set workspace_id = w.id
from public.workspaces w
where t.workspace_id is null
  and w.user_id = t.user_id
  and w.is_default;

-- 2. Blank rows left behind when a saved task's text was cleared.
delete from public.tasks
where trim(coalesce(content, '')) = '';

-- 3. Column definitions.
alter table public.tasks alter column user_id drop default;

alter table public.tasks
  alter column created_at type timestamptz using created_at at time zone 'UTC',
  alter column created_at set default now();

update public.tasks set completed = false where completed is null;
update public.tasks set is_subtask = false where is_subtask is null;

alter table public.tasks
  alter column type drop default,
  alter column type set not null,
  alter column content set not null,
  alter column content set default '',
  alter column date set not null,
  alter column completed set not null,
  alter column is_subtask set not null;

alter table public.tasks drop constraint if exists tasks_type_check;
alter table public.tasks
  add constraint tasks_type_check check (type in ('general', 'daily'));

-- 4. Soft delete was never used by the app (0 rows marked deleted).
drop index if exists public.tasks_user_active_idx;
alter table public.tasks drop column if exists deleted_at;

-- 5. Tie tasks to their owner. NOT VALID: existing rows are not checked (a
--    deleted user's leftover rows would otherwise abort the migration);
--    every new or updated row is.
alter table public.tasks drop constraint if exists tasks_user_id_fkey;
alter table public.tasks
  add constraint tasks_user_id_fkey
  foreign key (user_id) references auth.users (id) on delete cascade
  not valid;

-- 6. Deleting a user cascades to their workspaces; the old trigger rejected
--    that for the default one, so the user could not be deleted at all.
--    Only block the delete while the owner still exists.
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

commit;
