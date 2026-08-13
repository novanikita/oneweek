/**
 * Workspaces — top-right tabs that split tasks into independent buckets.
 *
 * Each task row in Supabase has a `workspace_id`. The active workspace id
 * lives in localStorage per user; all task panels (general + daily) filter
 * their reads, inserts, and cache keys by that id and re-render when it
 * changes via the `workspace-change` event on `window`.
 */
(() => {
  const ACTIVE_KEY_PREFIX = "oneweek-active-workspace-";
  const DEFAULT_WS_KEY_PREFIX = "oneweek-default-workspace-";
  const MIGRATED_KEY_PREFIX = "oneweek-workspaces-migrated-";
  const DEFAULT_NAME = "main";

  const WORKSPACE_CHANGE = "workspace-change";
  const WORKSPACE_LIST_CHANGE = "workspace-list-change";

  const state = {
    supabase: null,
    userId: null,
    list: [],
    activeId: null,
    ready: false,
    loadPromise: null,
  };

  function activeKey(userId) {
    return `${ACTIVE_KEY_PREFIX}${userId}`;
  }

  function migratedKey(userId) {
    return `${MIGRATED_KEY_PREFIX}${userId}`;
  }

  function defaultWorkspaceKey(userId) {
    return `${DEFAULT_WS_KEY_PREFIX}${userId}`;
  }

  function readDefaultWorkspaceId(userId) {
    try {
      return localStorage.getItem(defaultWorkspaceKey(userId));
    } catch {
      return null;
    }
  }

  function writeDefaultWorkspaceId(userId, id) {
    try {
      if (userId && id) localStorage.setItem(defaultWorkspaceKey(userId), id);
    } catch {
      /* storage blocked */
    }
  }

  /** Protected default workspace id — stable even if the user renames it. */
  function resolveDefaultWorkspaceId() {
    if (!state.userId || state.list.length === 0) return null;
    const stored = readDefaultWorkspaceId(state.userId);
    if (stored && state.list.some((w) => w.id === stored)) return stored;
    const flagged = state.list.find((w) => w.is_default);
    if (flagged?.id) {
      writeDefaultWorkspaceId(state.userId, flagged.id);
      return flagged.id;
    }
    const first = sortList(state.list)[0];
    if (first?.id) {
      writeDefaultWorkspaceId(state.userId, first.id);
      return first.id;
    }
    return null;
  }

  function isDefaultWorkspace(id) {
    if (!id) return false;
    return id === resolveDefaultWorkspaceId();
  }

  function getDefaultWorkspaceId() {
    return resolveDefaultWorkspaceId();
  }

  function readActiveFromStorage(userId) {
    try {
      return localStorage.getItem(activeKey(userId));
    } catch {
      return null;
    }
  }

  function writeActiveToStorage(userId, id) {
    try {
      if (id) localStorage.setItem(activeKey(userId), id);
      else localStorage.removeItem(activeKey(userId));
    } catch {
      /* storage blocked */
    }
  }

  function dispatchActive() {
    window.dispatchEvent(
      new CustomEvent(WORKSPACE_CHANGE, {
        detail: { id: state.activeId, userId: state.userId },
      })
    );
  }

  function dispatchList() {
    window.dispatchEvent(
      new CustomEvent(WORKSPACE_LIST_CHANGE, {
        detail: { list: state.list.slice(), activeId: state.activeId },
      })
    );
  }

  function sortList(list) {
    return list
      .slice()
      .sort(
        (a, b) =>
          (a.position ?? 0) - (b.position ?? 0) ||
          (a.created_at || "").localeCompare(b.created_at || "")
      );
  }

  function isWorkspaceConflictError(error) {
    if (!error) return false;
    const code = String(error.code || "");
    const msg = String(error.message || "").toLowerCase();
    return code === "23505" || msg.includes("duplicate") || msg.includes("unique");
  }

  /** Idempotent default workspace — safe when two tabs race on first login. */
  async function ensureDefaultWorkspaceExists() {
    let list = sortList(await fetchWorkspaces());
    if (list.length > 0) return list;

    try {
      await createDefaultWorkspace();
    } catch (err) {
      if (!isWorkspaceConflictError(err)) throw err;
    }

    list = sortList(await fetchWorkspaces());
    if (list.length === 0) {
      throw new Error("Default workspace missing after concurrent create");
    }
    return list;
  }

  async function fetchWorkspaces() {
    let { data, error } = await state.supabase
      .from("workspaces")
      .select("id, name, position, created_at, is_default")
      .eq("user_id", state.userId)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) {
      const msg = String(error.message || "").toLowerCase();
      if (msg.includes("is_default")) {
        ({ data, error } = await state.supabase
          .from("workspaces")
          .select("id, name, position, created_at")
          .eq("user_id", state.userId)
          .order("position", { ascending: true })
          .order("created_at", { ascending: true }));
      }
      if (error) throw error;
    }
    return data ?? [];
  }

  async function createDefaultWorkspace() {
    const { data, error } = await state.supabase
      .from("workspaces")
      .insert({
        user_id: state.userId,
        name: DEFAULT_NAME,
        position: 0,
        is_default: true,
      })
      .select("id, name, position, created_at, is_default")
      .single();
    if (error) {
      if (isWorkspaceConflictError(error)) {
        const list = sortList(await fetchWorkspaces());
        const existing = list.find((w) => w.is_default) || list[0];
        if (existing) {
          writeDefaultWorkspaceId(state.userId, existing.id);
          return existing;
        }
      }
      const msg = String(error.message || "").toLowerCase();
      if (!msg.includes("is_default")) throw error;
      const fallback = await state.supabase
        .from("workspaces")
        .insert({
          user_id: state.userId,
          name: DEFAULT_NAME,
          position: 0,
        })
        .select("id, name, position, created_at")
        .single();
      if (fallback.error) throw fallback.error;
      writeDefaultWorkspaceId(state.userId, fallback.data.id);
      return fallback.data;
    }
    writeDefaultWorkspaceId(state.userId, data.id);
    return data;
  }

  /** First-time setup: ensure the user has at least one workspace and that
   *  every task they already own gets pinned to it. */
  async function migrateIfNeeded() {
    let key;
    try {
      key = migratedKey(state.userId);
      if (localStorage.getItem(key) === "1") return;
    } catch {
      /* storage blocked — still safe to run, just may run again next reload */
    }

    if (state.list.length === 0) {
      state.list = await ensureDefaultWorkspaceExists();
    }

    const target = state.list[0];

    const { error } = await state.supabase
      .from("tasks")
      .update({ workspace_id: target.id })
      .eq("user_id", state.userId)
      .is("workspace_id", null);
    if (error) {
      console.error("Workspace backfill failed:", error);
      return;
    }
    try {
      localStorage.setItem(key, "1");
    } catch {
      /* ignore */
    }
  }

  function pickInitialActive() {
    const stored = readActiveFromStorage(state.userId);
    if (stored && state.list.some((w) => w.id === stored)) return stored;
    return state.list[0]?.id ?? null;
  }

  function defaultReconciledKey(userId) {
    return `oneweek-default-reconciled-${userId}`;
  }

  /** Once per user: prefer the legacy browser-stored default id over a fresh
   *  position-based server default from the is_default migration. */
  async function reconcileLegacyDefaultWorkspace() {
    if (!ensureSupabase() || !state.userId || state.list.length === 0) return;

    let reconcileKey;
    try {
      reconcileKey = defaultReconciledKey(state.userId);
      if (localStorage.getItem(reconcileKey) === "1") return;
    } catch {
      /* storage blocked — still attempt reconcile */
    }

    const storedId = readDefaultWorkspaceId(state.userId);
    const serverDefault = state.list.find((w) => w.is_default);
    const hasIsDefaultColumn = state.list.some((w) => "is_default" in w);

    let targetId = null;
    if (storedId && state.list.some((w) => w.id === storedId)) {
      targetId = storedId;
    } else if (serverDefault?.id) {
      targetId = serverDefault.id;
    } else {
      targetId = sortList(state.list)[0]?.id ?? null;
    }
    if (!targetId) return;

    if (hasIsDefaultColumn && targetId !== serverDefault?.id) {
      const { error: clearErr } = await state.supabase
        .from("workspaces")
        .update({ is_default: false })
        .eq("user_id", state.userId);
      if (clearErr) {
        console.warn("Default workspace reconcile (clear) failed:", clearErr);
      } else {
        const { error: setErr } = await state.supabase
          .from("workspaces")
          .update({ is_default: true })
          .eq("id", targetId)
          .eq("user_id", state.userId);
        if (setErr) {
          console.warn("Default workspace reconcile (set) failed:", setErr);
        } else {
          state.list = sortList(await fetchWorkspaces());
        }
      }
    }

    writeDefaultWorkspaceId(state.userId, targetId);

    try {
      if (reconcileKey) localStorage.setItem(reconcileKey, "1");
    } catch {
      /* ignore */
    }
  }

  async function loadForUser() {
    state.ready = false;
    try {
      state.list = sortList(await fetchWorkspaces());
      await migrateIfNeeded();
      await reconcileLegacyDefaultWorkspace();
      if (state.list.length === 0) {
        state.list = await ensureDefaultWorkspaceExists();
      }
      state.activeId = pickInitialActive();
      writeActiveToStorage(state.userId, state.activeId);
      resolveDefaultWorkspaceId();
      state.ready = true;
      dispatchList();
      dispatchActive();
    } catch (err) {
      state.ready = false;
      throw err;
    }
  }

  function beginLoadForUser() {
    state.loadPromise = loadForUser()
      .catch((err) => {
        console.error("Workspaces load failed:", err);
        throw err;
      })
      .finally(() => {
        if (!state.ready) {
          state.loadPromise = null;
        }
      });
    return state.loadPromise;
  }

  async function ensureLoadedForCurrentUser() {
    if (state.ready) return;
    if (state.loadPromise) {
      try {
        await state.loadPromise;
      } catch {
        /* logged in beginLoadForUser */
      }
    }
    if (!state.ready && state.userId) {
      await beginLoadForUser();
    }
  }

  function clear() {
    state.list = [];
    state.activeId = null;
    state.ready = false;
    dispatchList();
    dispatchActive();
  }

  function ensureSupabase() {
    if (!state.supabase) state.supabase = window.supabaseClient || null;
    return !!state.supabase;
  }

  async function init({ supabase } = {}) {
    state.supabase = supabase || window.supabaseClient || null;
    // Auth session is driven by the single hub in script.js (applyAuthSession).
  }

  async function applyAuthSession(session) {
    return applySession(session);
  }

  async function applySession(session) {
    const userId = session?.user?.id || null;
    if (userId === state.userId) {
      await ensureLoadedForCurrentUser();
      return;
    }
    state.userId = userId;
    if (!userId) {
      clear();
      state.loadPromise = null;
      return;
    }
    await beginLoadForUser();
  }

  async function ensureReady() {
    await ensureLoadedForCurrentUser();
  }

  /** Used by other modules (script.js panels) that resolve auth in parallel.
   *  Kicks off the workspace load if it hasn't started yet for this user. */
  async function ensureReadyFor(userId) {
    if (!userId) return;
    if (state.userId === userId && state.ready) return;
    if (state.userId !== userId) {
      state.userId = userId;
      if (!ensureSupabase()) return;
      await beginLoadForUser();
      return;
    }
    await ensureLoadedForCurrentUser();
  }

  function getActiveId() {
    return state.activeId;
  }

  function getList() {
    return state.list.slice();
  }

  function isReady() {
    return state.ready;
  }

  async function flushPendingTaskSaves() {
    if (typeof window.__flushAllTaskSaves === "function") {
      try {
        await window.__flushAllTaskSaves();
      } catch (err) {
        console.error("Flush before workspace change failed:", err);
      }
    }
  }

  async function setActive(id) {
    if (!id || id === state.activeId) return;
    if (!state.list.some((w) => w.id === id)) return;
    await flushPendingTaskSaves();
    state.activeId = id;
    writeActiveToStorage(state.userId, id);
    dispatchActive();
  }

  function nextPosition() {
    if (state.list.length === 0) return 0;
    return Math.max(...state.list.map((w) => w.position ?? 0)) + 1;
  }

  function defaultNewName() {
    const used = new Set(state.list.map((w) => w.name.toLowerCase()));
    let i = 1;
    while (used.has(`workspace ${i}`)) i += 1;
    return `workspace ${i}`;
  }

  async function create(rawName) {
    if (!ensureSupabase() || !state.userId) return null;
    const name = (rawName ?? "").trim() || defaultNewName();
    const { data, error } = await state.supabase
      .from("workspaces")
      .insert({
        user_id: state.userId,
        name,
        position: nextPosition(),
      })
      .select("id, name, position, created_at")
      .single();
    if (error) {
      console.error("Workspace create failed:", error);
      return null;
    }
    state.list = sortList([...state.list, data]);
    dispatchList();
    await setActive(data.id);
    return data;
  }

  async function rename(id, rawName) {
    if (!ensureSupabase() || !state.userId) return false;
    const name = (rawName ?? "").trim();
    if (!name) return false;
    const ws = state.list.find((w) => w.id === id);
    if (!ws || ws.name === name) return false;
    const previous = ws.name;
    ws.name = name;
    dispatchList();
    const { error } = await state.supabase
      .from("workspaces")
      .update({ name })
      .eq("id", id)
      .eq("user_id", state.userId);
    if (error) {
      console.error("Workspace rename failed:", error);
      ws.name = previous;
      dispatchList();
      return false;
    }
    return true;
  }

  /** Count persisted tasks in a workspace (for delete confirmation). */
  async function countTasks(workspaceId) {
    if (!ensureSupabase() || !state.userId || !workspaceId) return null;
    const { count, error } = await state.supabase
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("user_id", state.userId)
      .eq("workspace_id", workspaceId);
    if (error) {
      console.error("Workspace task count failed:", error);
      return null;
    }
    return count ?? 0;
  }

  function formatDeleteConfirmMessage(name, taskCount) {
    const label = name ? `"${name}"` : "this workspace";
    if (taskCount === null) {
      return `Delete workspace ${label}? All tasks in this workspace will be permanently deleted.`;
    }
    if (taskCount === 0) {
      return `Delete workspace ${label}?`;
    }
    const noun = taskCount === 1 ? "task" : "tasks";
    return `Delete workspace ${label}? This will permanently delete ${taskCount} ${noun}.`;
  }

  async function remove(id) {
    if (!ensureSupabase() || !state.userId) return false;
    if (state.list.length <= 1) return false;
    const idx = state.list.findIndex((w) => w.id === id);
    if (idx === -1) return false;
    if (isDefaultWorkspace(id)) return false;

    await flushPendingTaskSaves();

    const removed = state.list[idx];
    const remaining = state.list.filter((w) => w.id !== id);
    state.list = remaining;

    const nextActive =
      state.activeId === id
        ? remaining[Math.min(idx, remaining.length - 1)]?.id ?? null
        : state.activeId;

    const activeChanged = nextActive !== state.activeId;
    if (activeChanged) {
      state.activeId = nextActive;
      writeActiveToStorage(state.userId, nextActive);
    }
    dispatchList();
    if (activeChanged) dispatchActive();

    const { error } = await state.supabase
      .from("workspaces")
      .delete()
      .eq("id", id)
      .eq("user_id", state.userId);
    if (error) {
      const msg = String(error.message || "").toLowerCase();
      if (msg.includes("default workspace")) {
        console.warn("Default workspace delete blocked by server:", error.message);
      } else {
        console.error("Workspace delete failed:", error);
      }
      state.list = sortList([...state.list, removed]);
      dispatchList();
      return false;
    }
    return true;
  }

  async function reorder(orderedIds) {
    if (!ensureSupabase() || !state.userId) return false;
    if (!Array.isArray(orderedIds) || orderedIds.length !== state.list.length) {
      return false;
    }
    const byId = new Map(state.list.map((w) => [w.id, w]));
    const next = [];
    for (let i = 0; i < orderedIds.length; i++) {
      const ws = byId.get(orderedIds[i]);
      if (!ws) return false;
      next.push({ ...ws, position: i });
    }
    const previous = state.list;
    const previousPositions = new Map(
      previous.map((w) => [w.id, w.position ?? 0])
    );
    state.list = next;
    dispatchList();

    const updates = next.map((ws) => ({
      id: ws.id,
      position: ws.position,
    }));

    async function applyPositions(rows) {
      const results = await Promise.all(
        rows.map(({ id, position }) =>
          state.supabase
            .from("workspaces")
            .update({ position })
            .eq("id", id)
            .eq("user_id", state.userId)
        )
      );
      const failed = [];
      results.forEach((result, i) => {
        if (result.error) failed.push({ ...rows[i], error: result.error });
      });
      return failed;
    }

    let pending = updates;
    let failed = await applyPositions(pending);
    if (failed.length > 0) {
      pending = failed.map(({ id, position }) => ({ id, position }));
      failed = await applyPositions(pending);
    }

    if (failed.length > 0) {
      console.error("Workspace reorder failed:", failed[0].error);
      const failedIds = new Set(failed.map((f) => f.id));
      const toRevert = updates.filter((u) => !failedIds.has(u.id));
      if (toRevert.length > 0) {
        await Promise.allSettled(
          toRevert.map(({ id }) =>
            state.supabase
              .from("workspaces")
              .update({ position: previousPositions.get(id) ?? 0 })
              .eq("id", id)
              .eq("user_id", state.userId)
          )
        );
      }
      try {
        state.list = sortList(await fetchWorkspaces());
        dispatchList();
      } catch (err) {
        console.error("Workspace reorder reconcile failed:", err);
        state.list = previous;
        dispatchList();
      }
      return false;
    }
    return true;
  }

  window.oneweekWorkspaces = {
    init,
    applyAuthSession,
    ensureReady,
    ensureReadyFor,
    getActiveId,
    getList,
    isReady,
    setActive,
    create,
    rename,
    remove,
    reorder,
    countTasks,
    formatDeleteConfirmMessage,
    isDefaultWorkspace,
    getDefaultWorkspaceId,
    WORKSPACE_CHANGE,
    WORKSPACE_LIST_CHANGE,
  };

  if (typeof window !== "undefined") {
    void init();
  }
})();

