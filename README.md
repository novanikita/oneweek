# oneweek

One week on a screen — a vanilla HTML/CSS/JS week planner with a general task inbox, daily columns, Supabase auth, workspaces, and themes.

## Run locally

Static files only — serve the repo root with any static server, for example:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080/index.html`.

## Supabase setup

1. Create a Supabase project.
2. Point `index.html` at your project URL and anon key (`window.supabaseClient = supabase.createClient(...)`).
3. Run the SQL migrations below **in order** in the Supabase SQL editor.
4. Enable email auth (sign-up / sign-in) as needed.

The anon key is public by design; row-level security must protect user data.

## Database migrations (run once, in order)

| Order | File | Purpose |
|------:|------|---------|
| 1 | `db/2026-05-26-workspaces.sql` | `workspaces` table, `tasks.workspace_id`, RLS policies |
| 2 | `db/2026-05-27-task-position.sql` | `tasks.position` column + index for list ordering |
| 3 | `db/2026-08-13-workspace-is-default.sql` | Optional `workspaces.is_default` flag |

Each file is idempotent (`if not exists`, safe to re-run).

### RLS assumptions

- `workspaces`: users can select/insert/update/delete **only their own rows** (`auth.uid() = user_id`).
- `tasks`: same pattern — policies should restrict reads and writes to `auth.uid() = user_id`.
- The app filters tasks by `workspace_id`; without migrations applied, queries fail or return empty boards.

### After migrations

- New users get a default workspace (`main`) on first sign-in; existing tasks are backfilled to it.
- Task order is stored in `position` and synced after drag-and-drop.

## Deploying

Upload the repo (or build output) to static hosting. Bump cache-bust query params on `index.html` script/style links when JS or CSS changes.

If you use the included service worker (`sw.js`), deploy it at the site root and bump `CACHE` when precache URLs change.

## Auth

Sign-in / sign-up happens only in the guest modal. The settings sidebar shows account status and Logout when signed in, or a button that opens the guest modal when signed out.

## Language

- App chrome defaults to English.
- The about page (`about.html`) and offline banner read `localStorage` key `oneweek-about-lang` (`en` / `ru`).
