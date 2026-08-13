-- Optional: mark the protected default workspace by id (not by name).
-- Apply once in the Supabase SQL editor. Safe to re-run.
--
-- Note: position-based default below is the bootstrap for accounts with no
-- legacy browser default. On first login after this migration, the client
-- reconciles `oneweek-default-workspace-*` from localStorage via
-- reconcileLegacyDefaultWorkspace() in js/workspaces.js.

alter table public.workspaces
  add column if not exists is_default boolean not null default false;

-- One default per user: earliest workspace by position / created_at.
with ranked as (
  select
    id,
    row_number() over (
      partition by user_id
      order by position asc, created_at asc
    ) as rn
  from public.workspaces
)
update public.workspaces w
set is_default = (ranked.rn = 1)
from ranked
where w.id = ranked.id;

create unique index if not exists workspaces_one_default_per_user_idx
  on public.workspaces (user_id)
  where is_default;
