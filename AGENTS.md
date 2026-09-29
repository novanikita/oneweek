# Agent guide

Before changing behavior or adding features, read [PRODUCT.md](PRODUCT.md) — it is the source of truth for what oneweek is, its principles, and what it deliberately is not. If a task conflicts with it, stop and ask the owner. If a decision changes the product, update PRODUCT.md in the same change.

Setup, Supabase migrations, and deployment are in [README.md](README.md).

- Vanilla HTML/CSS/JS, no build step. Main logic lives in `js/script.js`.
- Pure task-list logic (subtasks, ordering, merge, time sort) lives in `js/task-model.js`; keep it free of DOM/network and cover changes with `node --test tests/`.
- After JS/CSS changes, bump the `?v=` cache-bust params in `index.html`; when precached URLs change, bump `CACHE` in `sw.js`.
- Schema changes go in a new idempotent file in `db/` and a row in the README migrations table.
