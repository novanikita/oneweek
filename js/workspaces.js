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

  /** Protected default workspace (server `is_default`, one per user). */
  function getDefaultWorkspaceId() {
    return state.list.find((w) => w.is_default)?.id ?? null;
  }

  function isDefaultWorkspace(id) {
    return !!id && id === getDefaultWorkspaceId();
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

  /** Idempotent default workspace — safe when two tabs race on first login
   *  (the unique `is_default` index rejects the second insert). */
  async function ensureDefaultWorkspaceExists() {
    let list = await fetchWorkspaces();
    if (list.length > 0) return list;

    const { error } = await state.supabase.from("workspaces").insert({
      user_id: state.userId,
      name: DEFAULT_NAME,
      position: 0,
      is_default: true,
    });
    if (error && !isWorkspaceConflictError(error)) throw error;

    list = await fetchWorkspaces();
    if (list.length === 0) {
      throw new Error("Default workspace missing after concurrent create");
    }
    return list;
  }

  async function fetchWorkspaces() {
    const { data, error } = await state.supabase
      .from("workspaces")
      .select("id, name, position, created_at, is_default")
      .eq("user_id", state.userId)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) throw error;
    return sortList(data ?? []);
  }

  function pickInitialActive() {
    const stored = readActiveFromStorage(state.userId);
    if (stored && state.list.some((w) => w.id === stored)) return stored;
    return getDefaultWorkspaceId() ?? state.list[0]?.id ?? null;
  }

  async function loadForUser() {
    state.ready = false;
    state.list = await ensureDefaultWorkspaceExists();
    state.activeId = pickInitialActive();
    writeActiveToStorage(state.userId, state.activeId);
    state.ready = true;
    dispatchList();
    dispatchActive();
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
    // Auth session is driven by the single hub in auth.js (applyAuthSession).
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
      .select("id, name, position, created_at, is_default")
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
        state.list = await fetchWorkspaces();
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

