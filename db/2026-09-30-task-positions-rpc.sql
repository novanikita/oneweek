-- Save a whole list's order in one request (was one UPDATE per row).
-- Runs as the caller, so RLS applies; rows of other users are never touched.
-- Run once in Supabase → SQL Editor BEFORE deploying the app version that
-- calls it (older versions don't use it, so running it early is safe).
-- Safe to re-run.

create or replace function public.set_task_positions(ids uuid[], positions int[])
returns void
language sql
security invoker
set search_path = ''
as $$
  update public.tasks t
  set position = o.pos
  from unnest(ids, positions) as o(id, pos)
  where t.id = o.id
    and t.user_id = auth.uid();
$$;

revoke all on function public.set_task_positions(uuid[], int[]) from public, anon;
grant execute on function public.set_task_positions(uuid[], int[]) to authenticated;
