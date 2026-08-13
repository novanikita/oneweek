-- Workspace ownership integrity + default workspace delete protection.
-- Apply once in the Supabase SQL editor. Safe to re-run.

-- Composite key so tasks can only reference a workspace owned by the same user.
alter table public.workspaces
  drop constraint if exists workspaces_id_user_unique;

alter table public.workspaces
  add constraint workspaces_id_user_unique unique (id, user_id);

alter table public.tasks
  drop constraint if exists tasks_workspace_id_fkey;

alter table public.tasks
  drop constraint if exists tasks_workspace_user_fkey;

alter table public.tasks
  add constraint tasks_workspace_user_fkey
  foreign key (workspace_id, user_id)
  references public.workspaces (id, user_id)
  on delete cascade;

-- Block deleting the protected default workspace at the database layer.
create or replace function public.prevent_default_workspace_delete()
returns trigger
language plpgsql
as $$
begin
  if old.is_default then
    raise exception 'Cannot delete default workspace';
  end if;
  return old;
end;
$$;

drop trigger if exists workspaces_prevent_default_delete on public.workspaces;

create trigger workspaces_prevent_default_delete
  before delete on public.workspaces
  for each row
  execute function public.prevent_default_workspace_delete();
