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

  async function fetchWorkspaces() {
    const { data, error } = await state.supabase
      .from("workspaces")
      .select("id, name, position, created_at")
      .eq("user_id", state.userId)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) throw error;
    return data ?? [];
  }

  async function createDefaultWorkspace() {
    const { data, error } = await state.supabase
      .from("workspaces")
      .insert({
        user_id: state.userId,
        name: DEFAULT_NAME,
        position: 0,
      })
      .select("id, name, position, created_at")
      .single();
    if (error) throw error;
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
      const created = await createDefaultWorkspace();
      state.list = [created];
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

  async function loadForUser() {
    state.ready = false;
    state.list = sortList(await fetchWorkspaces());
    await migrateIfNeeded();
    if (state.list.length === 0) {
      const created = await createDefaultWorkspace();
      state.list = [created];
    }
    state.activeId = pickInitialActive();
    writeActiveToStorage(state.userId, state.activeId);
    state.ready = true;
    dispatchList();
    dispatchActive();
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
    if (!state.supabase) return;

    const { data } = await state.supabase.auth.getSession();
    await applySession(data?.session ?? null);

    state.supabase.auth.onAuthStateChange((_event, session) => {
      void applySession(session);
    });
  }

  async function applySession(session) {
    const userId = session?.user?.id || null;
    if (userId === state.userId) {
      if (state.loadPromise) {
        try {
          await state.loadPromise;
        } catch {
          /* already logged */
        }
      }
      return;
    }
    state.userId = userId;
    if (!userId) {
      clear();
      return;
    }
    state.loadPromise = loadForUser().catch((err) => {
      console.error("Workspaces load failed:", err);
    });
    await state.loadPromise;
  }

  async function ensureReady() {
    if (state.ready) return;
    if (state.loadPromise) {
      try {
        await state.loadPromise;
      } catch {
        /* already logged */
      }
    }
  }

  /** Used by other modules (script.js panels) that resolve auth in parallel.
   *  Kicks off the workspace load if it hasn't started yet for this user. */
  async function ensureReadyFor(userId) {
    if (!userId) return;
    if (state.userId === userId && state.ready) return;
    if (state.userId !== userId) {
      state.userId = userId;
      if (!ensureSupabase()) return;
      state.loadPromise = loadForUser().catch((err) => {
        console.error("Workspaces load failed:", err);
      });
    }
    if (state.loadPromise) {
      try {
        await state.loadPromise;
      } catch {
        /* already logged */
      }
    }
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

  async function setActive(id) {
    if (!id || id === state.activeId) return;
    if (!state.list.some((w) => w.id === id)) return;
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

  async function remove(id) {
    if (!ensureSupabase() || !state.userId) return false;
    if (state.list.length <= 1) return false;
    const idx = state.list.findIndex((w) => w.id === id);
    if (idx === -1) return false;

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
      console.error("Workspace delete failed:", error);
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
    state.list = next;
    dispatchList();

    const updates = next.map((ws) =>
      state.supabase
        .from("workspaces")
        .update({ position: ws.position })
        .eq("id", ws.id)
        .eq("user_id", state.userId)
    );
    const results = await Promise.all(updates);
    const firstError = results.find((r) => r.error)?.error;
    if (firstError) {
      console.error("Workspace reorder failed:", firstError);
      state.list = previous;
      dispatchList();
      return false;
    }
    return true;
  }

  window.oneweekWorkspaces = {
    init,
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
    WORKSPACE_CHANGE,
    WORKSPACE_LIST_CHANGE,
  };

  if (typeof window !== "undefined") {
    void init();
  }
})();

