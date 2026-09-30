# oneweek

One week on a screen — a vanilla HTML/CSS/JS week planner with a general task inbox, daily columns, Supabase auth, workspaces, and themes.

## Run locally

Static files only — serve the repo root with any static server, for example:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080/index.html`.

## Tests

Pure task-list logic lives in `js/task-model.js` and is covered by Node's built-in test runner (Node 18+, no dependencies):

```bash
node --test tests/
```

UI regressions: `tests/e2e/run.sh` drives the real app in headless Chromium against an in-memory fake Supabase and records DB rows plus rendered lists after each step. Run it on two revisions and diff the results — see the header of `tests/e2e/run.sh`.

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
| 4 | `db/2026-08-13-workspace-integrity.sql` | Task/workspace ownership integrity |
| 5 | `db/2026-08-19-task-is-main.sql` | `tasks.is_main` for this week’s main thing |
| 6 | `db/2026-09-29-tasks-cleanup.sql` | Orphan/blank rows, strict columns, user FK, user-delete fix |
| 7 | `db/2026-09-29-user-settings.sql` | `user_settings` table: themes synced across devices |
| 8 | `db/2026-09-30-next-week-inbox.sql` | Old "Next week" rows → next week's task list. Run **after** deploying the app that reads the column that way; re-runnable |
| 9 | `db/2026-09-30-task-positions-rpc.sql` | `set_task_positions()`: a list's order saved in one request. Run **before** deploying the app that calls it |

Each file is idempotent (`if not exists`, safe to re-run).

For a fresh project, run `db/schema.sql` instead: it is the full current schema. Update it together with every new migration.

### RLS assumptions

- `workspaces`: users can select/insert/update/delete **only their own rows** (`auth.uid() = user_id`).
- `tasks`: same pattern — policies should restrict reads and writes to `auth.uid() = user_id`.
- The app filters tasks by `workspace_id`; without migrations applied, queries fail or return empty boards.

### After migrations

- New users get a protected default workspace (`main`, `workspaces.is_default`) on first sign-in.
- Task order is stored in `position` and synced after drag-and-drop.

## Deploying

### Vercel (recommended)

1. Import `novanikita/oneweek` in [Vercel](https://vercel.com/new) and connect GitHub.
2. Leave **Framework Preset** as *Other* — no build command, output is the repo root.
3. Deploy. `vercel.json` sets cache headers for `sw.js` and the web manifest.

After JS/CSS changes, bump cache-bust query params on `index.html` script/style links. When precache URLs change, bump `CACHE` in `sw.js`.

### Other static hosts

Upload the repo root to any static host. Deploy `sw.js` at the site root.

## Auth

Sign-in / sign-up happens only in the guest modal. The settings sidebar shows account status and Logout when signed in, or a button that opens the guest modal when signed out.

## Language

- App chrome defaults to English.
- The about page (`about.html`) and offline banner read `localStorage` key `oneweek-about-lang` (`en` / `ru`).
