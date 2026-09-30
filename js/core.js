/**
 * oneweek core — shared state and services with no task-row UI: the visible
 * week, undo stack, network status + offline banner, toasts, the per-task
 * save queue, save flushing, and the local task cache.
 */

/** Monday 00:00 of the week currently shown (week arrows / __weekOffset). */
function getVisibleWeekStartDate() {
  return getWeekMondayStart(new Date(), Number(window.__weekOffset || 0));
}

function getVisibleWeekMondayIso() {
  return toIsoDateFromDate(getVisibleWeekStartDate());
}

if (typeof window !== "undefined") {
  window.__weekOffset = Number(window.__weekOffset || 0);
}

/**
 * Undo stack (Ctrl/Cmd+Z). Each panel registers a restore handler; only trash
 * deletes are undoable — not checkbox toggles, drag moves, or text edits
 * (textarea keeps the browser's native undo).
 */
const oneweekUndoStack = [];
const oneweekUndoHandlers = new Map();
const ONEWEEK_UNDO_LIMIT = 50;

function oneweekRegisterUndoHandler(blockId, fn) {
  if (!blockId || typeof fn !== "function") return;
  oneweekUndoHandlers.set(blockId, fn);
}

function oneweekPushUndo(entry) {
  if (!entry || !entry.blockId) return;
  oneweekUndoStack.push(entry);
  if (oneweekUndoStack.length > ONEWEEK_UNDO_LIMIT) oneweekUndoStack.shift();
}

async function oneweekPerformUndo() {
  while (oneweekUndoStack.length > 0) {
    const entry = oneweekUndoStack.pop();
    const handler = oneweekUndoHandlers.get(entry.blockId);
    if (!handler) continue;
    try {
      const handled = await handler(entry);
      if (handled !== false) return;
      // handler returned false → this entry is no longer applicable
      // (e.g. user switched to another week); try the next one.
    } catch (err) {
      console.error("Undo handler failed:", err);
      return;
    }
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("keydown", (e) => {
    // Cmd+Z (mac) / Ctrl+Z (everywhere else). Skip Cmd+Shift+Z to leave room
    // for a future redo.
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.shiftKey) return;
    if (e.key !== "z" && e.key !== "Z") return;
    // Don't fight the browser's native undo inside text fields.
    const t = e.target;
    if (t) {
      const tag = t.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT" || t.isContentEditable) return;
    }
    if (oneweekUndoStack.length === 0) return;
    e.preventDefault();
    void oneweekPerformUndo();
  });
}

const WEEK_CHANGE_EVENT = "week-offset-change";

/**
 * Network status — drives the offline banner and lets us know when to retry
 * pending task writes. We only flip to "offline" when a Supabase call actually
 * fails with a network-level error (or `navigator.onLine` reports offline);
 * server errors like RLS rejections don't show the banner.
 */
const oneweekNet = {
  hasNetFailure: false,
  retryListeners: new Set(),
};

function isLikelyNetworkError(err) {
  if (!err) return false;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  const message = String(err?.message ?? err ?? "").toLowerCase();
  if (!message) return false;
  return (
    message.includes("failed to fetch") ||
    message.includes("networkerror") ||
    message.includes("network error") ||
    message.includes("load failed") ||
    message.includes("err_internet_disconnected") ||
    message.includes("err_network") ||
    message.includes("err_name_not_resolved") ||
    message.includes("err_connection")
  );
}

function isOnline() {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

const UI_LANG_STORAGE_KEY = "oneweek-about-lang";

const CONNECTION_BANNER_STRINGS = {
  en: "No connection right now, but your tasks are still saved locally.",
  ru: "Пока нет связи, но задачи всё равно сохраняются.",
};

function getUiLang() {
  try {
    return localStorage.getItem(UI_LANG_STORAGE_KEY) === "ru" ? "ru" : "en";
  } catch {
    return "en";
  }
}

function undoKeyboardHint() {
  if (typeof navigator === "undefined") return "Ctrl+Z";
  const platform = navigator.platform || "";
  return /Mac|iPhone|iPad|iPod/.test(platform) ? "⌘Z" : "Ctrl+Z";
}

function wireTaskDeleteButton(deleteBtn) {
  const hint = undoKeyboardHint();
  deleteBtn.setAttribute("aria-label", `Delete task. Undo with ${hint}.`);
  deleteBtn.title = `Delete (${hint} to undo)`;
}

let undoHintTimer = null;

function showUndoDeleteHint() {
  const el = document.getElementById("undo-hint");
  if (!el) return;
  const lang = getUiLang();
  el.textContent =
    lang === "ru"
      ? `Удалено. ${undoKeyboardHint()} — отменить.`
      : `Deleted. Press ${undoKeyboardHint()} to undo.`;
  el.hidden = false;
  if (undoHintTimer) clearTimeout(undoHintTimer);
  undoHintTimer = setTimeout(() => {
    el.hidden = true;
    undoHintTimer = null;
  }, 3200);
}

let appToastTimer = null;

function showAppToast(message) {
  const el = document.getElementById("app-toast");
  if (!el || !message) return;
  el.textContent = message;
  el.hidden = false;
  if (appToastTimer) clearTimeout(appToastTimer);
  appToastTimer = setTimeout(() => {
    el.hidden = true;
    appToastTimer = null;
  }, 3200);
}

function showMainThingLimitToast() {
  showAppToast("There can only be one main thing :)");
}

function updateConnectionBanner() {
  const banner = document.getElementById("connection-banner");
  if (!banner) return;
  const textEl = banner.querySelector(".connection-banner-text");
  if (textEl) {
    const lang = getUiLang();
    textEl.textContent =
      CONNECTION_BANNER_STRINGS[lang] || CONNECTION_BANNER_STRINGS.en;
  }
  const offline = !isOnline() || oneweekNet.hasNetFailure;
  banner.hidden = !offline;
}

function markNetworkSuccess() {
  if (!oneweekNet.hasNetFailure) {
    updateConnectionBanner();
    return;
  }
  oneweekNet.hasNetFailure = false;
  updateConnectionBanner();
}

function markNetworkFailure(err) {
  if (!isLikelyNetworkError(err)) return;
  scheduleNetworkPoll();
  if (oneweekNet.hasNetFailure) return;
  oneweekNet.hasNetFailure = true;
  updateConnectionBanner();
}

let networkPollTimer = null;
/**
 * `navigator.onLine` doesn't fire `online` when only Supabase is unreachable
 * (e.g. blocked by ISP, DNS, or just flaky VPN). Poll a retry every 15s while
 * we still think the network is broken; `markNetworkSuccess()` clears the flag
 * and ends the loop.
 */
function scheduleNetworkPoll() {
  if (networkPollTimer) return;
  networkPollTimer = setInterval(() => {
    if (!oneweekNet.hasNetFailure) {
      clearInterval(networkPollTimer);
      networkPollTimer = null;
      return;
    }
    triggerNetworkRetry();
  }, 15000);
}

function onNetworkRetry(fn) {
  oneweekNet.retryListeners.add(fn);
  return () => oneweekNet.retryListeners.delete(fn);
}

function triggerNetworkRetry() {
  for (const fn of [...oneweekNet.retryListeners]) {
    try {
      void fn();
    } catch (err) {
      console.error("Retry listener failed:", err);
    }
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    oneweekNet.hasNetFailure = false;
    updateConnectionBanner();
    triggerNetworkRetry();
  });
  window.addEventListener("offline", () => {
    updateConnectionBanner();
  });
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", updateConnectionBanner);
    } else {
      updateConnectionBanner();
    }
  }
}

/**
 * Per-task serialized persist queue. `getContext()` adds fields frozen at
 * queue time (e.g. the list address) so a week or workspace switch while a
 * write waits cannot redirect it.
 */
function createPersistTask(
  insertOrUpdateTaskInDb,
  logPrefix = "Supabase persist failed:",
  onSettled = null,
  getContext = null
) {
  const pendingPersist = new Map();
  return async function persistTask(task) {
    if (!task?.id) return;
    const key = task.id;
    const tail = pendingPersist.get(key);
    const snapshot = {
      dbId: task.dbId ?? null,
      text: String(task.text ?? ""),
      checked: !!task.checked,
      subtask: !!task.subtask,
      color: normalizeTaskColor(task.color),
      isMain: !!task.isMain,
      // Frozen at queue time so a workspace switch mid-persist cannot insert
      // into the wrong bucket.
      workspaceId: getActiveWorkspaceId() ?? null,
      ...(getContext ? getContext() : null),
    };
    let writeFailed = false;
    const next = (tail ?? Promise.resolve())
      .then(() => insertOrUpdateTaskInDb(task, snapshot))
      .catch((err) => {
        writeFailed = true;
        markNetworkFailure(err);
        console.error(logPrefix, err);
      });
    pendingPersist.set(key, next);
    try {
      await next;
    } finally {
      if (pendingPersist.get(key) === next) {
        pendingPersist.delete(key);
      }
      if (task) {
        // Keep `_dirty` so the next flush / retry picks the task up again.
        if (writeFailed) task._dirty = true;
        else task._dirty = false;
      }
      // Let the panel refresh its on-disk cache so a brand-new row's freshly
      // assigned dbId is captured. Without this, a reload right after creating
      // a task (before the next render call) restores the row from cache with
      // dbId=null and the next server fetch re-introduces it as a duplicate.
      if (!writeFailed && typeof onSettled === "function") {
        try { onSettled(task); } catch (err) {
          console.error("persistTask onSettled failed:", err);
        }
      }
    }
  };
}

/** Mark in-memory task as needing a DB write (used with global flush). */
function markTaskDirty(task) {
  if (task) task._dirty = true;
}

const taskSaveFlushes = [];

function registerTaskSaveFlush(flushFn) {
  taskSaveFlushes.push(flushFn);
}

/** Flush every registered block (focused field + dirty tasks). */
async function flushAllTaskSaves() {
  await Promise.all(taskSaveFlushes.map((fn) => fn()));
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden") return;
    void flushAllTaskSaves();
  });
  window.addEventListener("pagehide", () => {
    void flushAllTaskSaves();
  });
}

/**
 * Local cache of the user's tasks, by week (general) or by day (daily).
 *
 * Why this exists: Supabase is hosted on AWS and is intermittently unreachable
 * from some networks (e.g. parts of Russia without a VPN). When `select` fails,
 * we previously left `state.tasks = []` and the user saw a blank board even
 * though their data is fine in the DB. The cache lets us paint the last known
 * good state immediately, and we only replace it when the server actually
 * answers. Locally edited state is also persisted here so offline edits survive
 * a reload.
 */
function generalTasksCacheKey(userId, weekIso, workspaceId) {
  const ws = workspaceId ? `-${workspaceId}` : "";
  return `oneweek-cache-general-${userId}-${weekIso}${ws}`;
}

function dailyTasksCacheKey(userId, dayName, date, workspaceId) {
  const ws = workspaceId ? `-${workspaceId}` : "";
  return `oneweek-cache-daily-${userId}-${dayName}-${date}${ws}`;
}

function getActiveWorkspaceId() {
  try {
    const ws = window.oneweekWorkspaces;
    if (!ws) return null;
    // Fail closed: never treat an id as active until the module finished loading.
    if (typeof ws.isReady === "function" && !ws.isReady()) return null;
    return ws.getActiveId?.() || null;
  } catch {
    return null;
  }
}

function readTasksCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.tasks)) return null;
    return parsed.tasks;
  } catch (_) {
    return null;
  }
}

/**
 * Save the list order (positions 0..n-1 of saved rows) in one request via
 * the `set_task_positions` DB function — atomic, so a failure leaves the old
 * order intact and the rows stay marked for a retry.
 */
async function persistTaskPositions(supabase, userId, tasks) {
  if (!supabase || !userId || !tasks?.length) return;
  const ids = [];
  const positions = [];
  tasks.forEach((t, i) => {
    if (t.dbId == null) return;
    ids.push(t.dbId);
    positions.push(i);
  });
  if (ids.length === 0) return;

  syncPositionsFromArray(tasks);
  const { error } = await supabase.rpc("set_task_positions", { ids, positions });
  const saved = tasks.filter((t) => t.dbId);
  if (error) {
    markNetworkFailure(error);
    for (const t of saved) t._positionDirty = true;
    throw error;
  }
  for (const t of saved) t._positionDirty = false;
  markNetworkSuccess();
}

function createPositionPersistScheduler(supabase, getUserId, getTasks) {
  let chain = Promise.resolve();
  let retryQueued = false;

  function runPersist() {
    const userId = getUserId();
    const tasks = getTasks();
    if (!supabase || !userId || !tasks?.length) return Promise.resolve();
    return persistTaskPositions(supabase, userId, tasks);
  }

  return function schedulePersistTaskPositions() {
    const userId = getUserId();
    const tasks = getTasks();
    if (!supabase || !userId || !tasks?.length) return;

    chain = chain
      .then(() => runPersist())
      .catch((err) => {
        console.error("Supabase position persist failed:", err);
        if (!retryQueued && tasks.some((t) => t._positionDirty)) {
          retryQueued = true;
          chain = chain
            .then(() => runPersist())
            .catch((retryErr) => {
              console.error("Supabase position persist retry failed:", retryErr);
            })
            .finally(() => {
              retryQueued = false;
            });
        }
      });
  };
}

function writeTasksCache(key, tasks) {
  try {
    const serializable = (tasks || []).map((t, i) => ({
      dbId: t.dbId ?? null,
      text: String(t.text ?? ""),
      checked: !!t.checked,
      subtask: !!t.subtask,
      color: normalizeTaskColor(t.color),
      position: typeof t.position === "number" ? t.position : i,
      isMain: !!t.isMain,
      // `_dirty` survives reload so unsynced offline edits are retried.
      dirty: !!t._dirty,
    }));
    localStorage.setItem(
      key,
      JSON.stringify({ tasks: serializable, savedAt: Date.now() })
    );
  } catch (_) {
    /* localStorage may be full or disabled — ignore. */
  }
}

/** Cached lists and marks for weeks older than this many weeks are dropped. */
const LOCAL_DATA_KEEP_WEEKS = 8;

/** Keys written by client-side migrations that no longer exist. */
const OBSOLETE_LOCAL_KEY_PREFIXES = [
  "oneweek-default-workspace-",
  "oneweek-workspaces-migrated-",
  "oneweek-default-reconciled-",
  "oneweek-general-date-migrated-",
];

/**
 * Keep localStorage bounded: drop cached lists and "move remaining" marks of
 * weeks long past (never a list with unsynced edits) and obsolete keys.
 */
function pruneLocalData() {
  try {
    const cutoff = toIsoDateFromDate(getWeekMondayStart(new Date(), -LOCAL_DATA_KEEP_WEEKS));
    const drop = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith("oneweek-")) continue;
      if (OBSOLETE_LOCAL_KEY_PREFIXES.some((prefix) => k.startsWith(prefix))) {
        drop.push(k);
        continue;
      }
      const isCache = k.startsWith("oneweek-cache-");
      if (!isCache && !k.startsWith("oneweek-move-remaining-done-")) continue;
      // Ids are UUIDs (hex groups of 4+), so this only matches the date part.
      const date = k.match(/\d{4}-\d{2}-\d{2}/)?.[0];
      if (!date || date >= cutoff) continue;
      if (isCache && (readTasksCache(k) ?? []).some((t) => t.dirty)) continue;
      drop.push(k);
    }
    for (const k of drop) localStorage.removeItem(k);
  } catch (_) {
    /* storage blocked */
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("load", () => setTimeout(pruneLocalData, 3000));
}

/** True if any cached list still holds edits that never reached the server. */
function hasUnsyncedTaskEdits() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith("oneweek-cache-")) continue;
      if ((readTasksCache(k) ?? []).some((t) => t.dirty)) return true;
    }
  } catch (_) {
    /* storage blocked */
  }
  return false;
}

/** Remove plaintext task caches (privacy: shared devices / after logout). */
function clearAllTasksCaches() {
  try {
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (
        k &&
        (k.startsWith("oneweek-cache-general-") ||
          k.startsWith("oneweek-cache-daily-"))
      ) {
        toRemove.push(k);
      }
    }
    for (const k of toRemove) localStorage.removeItem(k);
  } catch (_) {
    /* ignore */
  }
}

if (typeof window !== "undefined") {
  window.__flushAllTaskSaves = flushAllTaskSaves;
}
