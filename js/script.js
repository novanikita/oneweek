/**
 * One Week — shared helpers and task utilities used by the general panel,
 * week/day panels, week navigation, and auth UI.
 */

/** Monday 00:00 of the week currently shown (week arrows / __weekOffset). */
function getVisibleWeekStartDate() {
  return getWeekMondayStart(new Date(), Number(window.__weekOffset || 0));
}

function getVisibleWeekMondayIso() {
  return toIsoDateFromDate(getVisibleWeekStartDate());
}

function prefersReducedMotion() {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * FLIP (First, Last, Invert, Play): capture `.task-row` rects before a
 * re-render and animate the visual displacement after. Used by both the
 * general and daily renders so checking a task, dragging it within a list,
 * or sliding it on/off the completed pile glides instead of snapping.
 */
function captureTaskRowRects(rootEl) {
  if (!rootEl) return null;
  const map = new Map();
  const rows = rootEl.querySelectorAll(".task-row[data-id]");
  for (const row of rows) {
    const id = row.dataset.id;
    if (!id) continue;
    map.set(id, row.getBoundingClientRect());
  }
  return map;
}

function playTaskRowFlip(rootEl, beforeMap) {
  if (!rootEl || !beforeMap || beforeMap.size === 0) return;
  if (prefersReducedMotion()) return;
  const rows = rootEl.querySelectorAll(".task-row[data-id]");
  const animated = [];
  for (const row of rows) {
    const id = row.dataset.id;
    const before = beforeMap.get(id);
    if (!before) continue;
    const after = row.getBoundingClientRect();
    const dx = before.left - after.left;
    const dy = before.top - after.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    row.style.transition = "none";
    row.style.transform = `translate(${dx}px, ${dy}px)`;
    row.style.willChange = "transform";
    animated.push(row);
  }
  if (animated.length === 0) return;
  requestAnimationFrame(() => {
    for (const row of animated) {
      row.style.transition = "transform 280ms cubic-bezier(0.22, 1, 0.36, 1)";
      row.style.transform = "";
    }
    window.setTimeout(() => {
      for (const row of animated) {
        row.style.transition = "";
        row.style.transform = "";
        row.style.willChange = "";
      }
    }, 320);
  });
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

function getTaskInputOneLineHeight(input) {
  const style = getComputedStyle(input);
  const lineHeight = parseFloat(style.lineHeight) || 18;
  const paddingTop = parseFloat(style.paddingTop) || 0;
  const paddingBottom = parseFloat(style.paddingBottom) || 0;
  return lineHeight + paddingTop + paddingBottom;
}

function syncTaskRowMultiline(input) {
  const row = input?.closest?.(".task-row");
  if (!row || !input) return;
  const oneLineHeight = getTaskInputOneLineHeight(input);
  const multiline = input.scrollHeight > oneLineHeight + 1;
  row.classList.toggle("task-row-multiline", multiline);
}

function autoSizeTextarea(el) {
  if (!el) return;
  const row = el.closest(".task-row");
  const wasMultiline = row?.classList.contains("task-row-multiline");

  // Clear any CSS max-height while measuring so wrapped text can report a
  // real scrollHeight (mobile single-line rows use max-height: var(--task-line)).
  const prevMaxHeight = el.style.maxHeight;
  el.style.maxHeight = "none";
  el.style.height = "0";
  syncTaskRowMultiline(el);

  // For single-line rows we always pin the height to the exact computed
  // line-height + paddings. Using scrollHeight here causes ±1px jitter
  // between empty and filled rows because browsers round scrollHeight to a
  // whole pixel while the CSS line-height is fractional (e.g. 19.2 vs 20).
  const oneLineHeight = getTaskInputOneLineHeight(el);
  const isMultiline = row?.classList.contains("task-row-multiline");
  let safeHeight = isMultiline
    ? Math.max(el.scrollHeight, oneLineHeight) + 2
    : oneLineHeight;
  el.style.height = `${safeHeight}px`;

  // Re-measure once if the multiline flag toggled — applying the new height
  // can change scrollHeight (e.g. wider single-line content reflows narrower).
  if (wasMultiline !== isMultiline) {
    el.style.height = "0";
    safeHeight = isMultiline
      ? Math.max(el.scrollHeight, oneLineHeight) + 2
      : oneLineHeight;
    el.style.height = `${safeHeight}px`;
  }
  el.style.maxHeight = prevMaxHeight;
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

const EMAIL_OTP_TYPES = new Set([
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email",
]);

function getAuthEmailRedirectTo() {
  const origin = window.location.origin;
  if (!origin || origin === "null" || !/^https?:\/\//.test(origin)) return undefined;
  return `${origin}/`;
}

function readAuthCallbackParams() {
  const url = new URL(window.location.href);
  const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
  const get = (key) => url.searchParams.get(key) || hash.get(key) || "";
  return { url, get };
}

function friendlyAuthCallbackError(raw) {
  const msg = decodeURIComponent(String(raw || "").replace(/\+/g, " ")).trim();
  const lower = msg.toLowerCase();
  if (lower.includes("expired") || lower.includes("invalid")) {
    return "This confirmation link is invalid or has expired. Create the account again to get a new email.";
  }
  return msg || "Couldn't confirm email.";
}

function stripAuthCallbackFromAddress() {
  const url = new URL(window.location.href);
  const keys = [
    "token_hash",
    "type",
    "next",
    "code",
    "error",
    "error_code",
    "error_description",
    "error_link_type",
  ];
  let changed = false;
  for (const key of keys) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (/access_token|refresh_token|error_description|error=|token_hash/.test(url.hash)) {
    url.hash = "";
    changed = true;
  }
  let path = url.pathname;
  if (path === "/auth/confirm" || path.startsWith("/auth/")) {
    path = "/";
    changed = true;
  }
  if (!changed) return;
  const search = url.searchParams.toString();
  history.replaceState({}, "", path + (search ? `?${search}` : "") + url.hash);
}

/**
 * Confirm-signup emails often land on /auth/confirm?token_hash=… (or /?code=…).
 * Exchange the token here so the user is signed in on this static app.
 */
async function consumeEmailAuthCallback(supabase) {
  const { get } = readAuthCallbackParams();
  const errorCode = get("error") || get("error_code");
  const errorDescription = get("error_description");
  if (errorCode || errorDescription) {
    window.__oneweekAuthCallbackError = friendlyAuthCallbackError(
      errorDescription || errorCode
    );
    stripAuthCallbackFromAddress();
    return;
  }

  const tokenHash = get("token_hash");
  const typeRaw = get("type");
  if (tokenHash) {
    const type = EMAIL_OTP_TYPES.has(typeRaw) ? typeRaw : "email";
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type,
    });
    if (error) {
      window.__oneweekAuthCallbackError = friendlyAuthCallbackError(
        error.message
      );
    }
    stripAuthCallbackFromAddress();
  }
}

/**
 * Single auth subscription for the app. Workspaces load first, then panel
 * listeners run — avoids each panel calling getSession + onAuthStateChange.
 */
const ONEWEEK_AUTH_CHANGE = "oneweek-auth-change";

(function setupOneweekAuthHub() {
  if (typeof window === "undefined" || window.oneweekAuth) return;
  const supabase = window.supabaseClient;
  if (!supabase) return;

  let session = null;
  let initialized = false;
  const listeners = new Set();
  let chain = Promise.resolve();

  async function publish(nextSession) {
    session = nextSession ?? null;
    try {
      await window.oneweekWorkspaces.applyAuthSession(session);
    } catch (err) {
      console.error("Workspace auth apply failed:", err);
    }
    for (const fn of [...listeners]) {
      try {
        await fn(session);
      } catch (err) {
        console.error("Auth listener failed:", err);
      }
    }
    window.dispatchEvent(
      new CustomEvent(ONEWEEK_AUTH_CHANGE, { detail: { session } })
    );
  }

  function enqueue(nextSession) {
    chain = chain.then(() => publish(nextSession)).catch((err) => {
      console.error("Auth hub publish failed:", err);
    });
    return chain;
  }

  window.oneweekAuth = {
    getSession: () => session,
    isReady: () => initialized,
    whenReady: () => readyPromise,
    subscribe(fn) {
      listeners.add(fn);
      if (initialized) void fn(session);
      return () => listeners.delete(fn);
    },
  };

  // Subscribe before async init so sign-in/out during startup is not missed.
  let authEventsSeen = 0;
  supabase.auth.onAuthStateChange((_event, nextSession) => {
    authEventsSeen += 1;
    void enqueue(nextSession);
  });

  const readyPromise = (async () => {
    try {
      const hadAuthCode =
        new URLSearchParams(window.location.search).has("code") ||
        /(?:^|[&#])code=/.test(window.location.hash);

      await consumeEmailAuthCallback(supabase);

      const { data } = await supabase.auth.getSession();
      if (
        hadAuthCode &&
        !data?.session &&
        !window.__oneweekAuthCallbackError
      ) {
        window.__oneweekAuthCallbackError =
          "Couldn't finish signing in from this link. Open it on the same device you used to create the account, or create the account again.";
      }
      stripAuthCallbackFromAddress();
      if (authEventsSeen === 0) {
        await enqueue(data?.session ?? null);
      }
    } catch (err) {
      console.error("Auth hub init failed:", err);
      if (authEventsSeen === 0) {
        await enqueue(null);
      }
    } finally {
      initialized = true;
    }
  })();
})();

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

/** Push 0..n-1 positions for persisted rows (after drag, toggle, paste, etc.). */
async function persistTaskPositions(supabase, userId, tasks) {
  if (!supabase || !userId || !tasks?.length) return;

  const updates = [];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (t.dbId == null) continue;
    updates.push({
      dbId: t.dbId,
      newPosition: i,
      oldPosition: typeof t.position === "number" ? t.position : i,
    });
  }
  if (updates.length === 0) return;

  syncPositionsFromArray(tasks);

  async function applyPositions(rows) {
    const results = await Promise.all(
      rows.map(({ dbId, newPosition }) =>
        supabase
          .from("tasks")
          .update({ position: newPosition })
          .eq("id", dbId)
          .eq("user_id", userId)
      )
    );
    const failed = [];
    results.forEach((result, i) => {
      if (result.error) failed.push({ ...rows[i], error: result.error });
    });
    return failed;
  }

  let pending = updates.map(({ dbId, newPosition }) => ({ dbId, newPosition }));
  let failed = await applyPositions(pending);
  if (failed.length > 0) {
    pending = failed.map(({ dbId, newPosition }) => ({ dbId, newPosition }));
    failed = await applyPositions(pending);
  }

  if (failed.length > 0) {
    markNetworkFailure(failed[0].error);
    const failedIds = new Set(failed.map((f) => f.dbId));
    const toRevert = updates.filter((u) => !failedIds.has(u.dbId));
    if (toRevert.length > 0) {
      await Promise.allSettled(
        toRevert.map(({ dbId, oldPosition }) =>
          supabase
            .from("tasks")
            .update({ position: oldPosition })
            .eq("id", dbId)
            .eq("user_id", userId)
        )
      );
    }
    for (const t of tasks) {
      if (t.dbId) t._positionDirty = true;
    }
    throw failed[0].error;
  }

  for (const t of tasks) {
    if (t.dbId) t._positionDirty = false;
  }
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

/** Pointer coords packaged like a drop/dragover event (touch cross-panel). */
function syntheticPointerEvent(clientX, clientY) {
  const target = document.elementFromPoint(clientX, clientY) || document.body;
  return {
    clientX,
    clientY,
    target,
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() {},
  };
}

function findTaskPanelAtPoint(clientX, clientY) {
  const hit = document.elementFromPoint(clientX, clientY);
  if (!hit) return null;

  const tasksField = document.getElementById("tasks-field");
  const tasksFieldRoot = document.getElementById("tasks-field-root");
  if (tasksField?.contains(hit) || tasksFieldRoot?.contains(hit)) {
    return {
      blockId: "general",
      listEl: tasksFieldRoot?.querySelector(".tasks-list"),
      anchorEl: tasksField,
    };
  }

  const dayTasks = hit.closest(".day-tasks");
  if (dayTasks) {
    const dayRect = dayTasks.closest(".day-rect");
    const dayName = dayRect?.dataset?.day;
    if (!dayName) return null;
    return {
      blockId: `day:${dayName}`,
      listEl: dayTasks.querySelector(".tasks-list"),
      anchorEl: dayTasks,
    };
  }
  return null;
}

/** Route a touch drop to another task panel (general ↔ daily). */
function tryTouchCrossPanelDrop(clientX, clientY, sourceBlock) {
  const payload = window.__dragTaskPayload;
  if (!payload?.sourceBlock || payload.sourceBlock !== sourceBlock) return false;
  const target = findTaskPanelAtPoint(clientX, clientY);
  if (!target || target.blockId === sourceBlock) return false;
  hideAllTaskDropIndicators();
  window.dispatchEvent(
    new CustomEvent("task-touch-cross-drop", {
      detail: {
        clientX,
        clientY,
        payload,
        targetBlock: target.blockId,
      },
    })
  );
  return true;
}

const ONEWEEK_DRAG_PAYLOAD_MIME = "application/x-oneweek-task-payload";

function readDragPayloadFromEvent(e) {
  const g =
    typeof window !== "undefined" && window.__dragTaskPayload != null
      ? window.__dragTaskPayload
      : null;
  if (g && typeof g === "object" && typeof g.sourceBlock === "string") return g;
  try {
    const raw = e?.dataTransfer?.getData?.(ONEWEEK_DRAG_PAYLOAD_MIME);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_) {
    return null;
  }
}

function writeDragPayloadToDataTransfer(dataTransfer, payload) {
  if (!dataTransfer || !payload) return;
  try {
    dataTransfer.setData(ONEWEEK_DRAG_PAYLOAD_MIME, JSON.stringify(payload));
  } catch (err) {
    console.warn("oneweek: could not store drag payload on dataTransfer", err);
  }
}

/** True between drag-handle mousedown and dragend / mouseup (blur can fire before dragstart). */
let taskDragInteractionActive = false;

function createTaskDragHandle() {
  const handle = document.createElement("div");
  handle.className = "task-drag-handle";
  handle.setAttribute("role", "button");
  handle.setAttribute("tabindex", "-1");
  handle.setAttribute("aria-label", "Reorder task");
  const icon = document.createElement("span");
  icon.className = "task-drag-handle-icon";
  icon.setAttribute("aria-hidden", "true");
  handle.appendChild(icon);
  return handle;
}

/** Highlight CSS var with concrete hex fallback if the palette token is missing. */
function taskHighlightCssVar(color) {
  const c = normalizeTaskColor(color);
  if (!c) return "";
  const token = c.slice(1);
  return `var(--task-hl-${token}, ${c})`;
}

/** Apply / clear the highlight color on a task row element. */
function applyTaskRowColor(row, color) {
  if (!row) return;
  const c = normalizeTaskColor(color);
  if (c) {
    row.dataset.color = c;
    row.style.setProperty("--task-hl", taskHighlightCssVar(c));
    row.style.background = "";
  } else {
    delete row.dataset.color;
    row.style.removeProperty("--task-hl");
    row.style.background = "";
  }
}

function createTaskColorButton() {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "task-color";
  btn.setAttribute("aria-label", "Set task color");
  const dot = document.createElement("span");
  dot.className = "task-color-dot";
  dot.setAttribute("aria-hidden", "true");
  btn.appendChild(dot);
  return btn;
}

function createTaskIndentButton(isSubtask) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "task-indent";
  const label = isSubtask ? "Make a regular task" : "Make subtask";
  btn.setAttribute("aria-label", label);
  btn.title = label;
  return btn;
}

function createTaskStarButton(isOn) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `task-star${isOn ? " is-on" : ""}`;
  btn.setAttribute(
    "aria-label",
    isOn ? "Remove as this week’s main thing" : "Set as this week’s main thing"
  );
  btn.title = isOn ? "This week’s main thing" : "Set as this week’s main thing";
  btn.setAttribute("aria-pressed", isOn ? "true" : "false");
  return btn;
}

/** Click target between unchecked and completed rows when the gap is tight. */
function createTasksListAddSpacer() {
  const el = document.createElement("div");
  el.className = "tasks-list-add-spacer";
  el.setAttribute("aria-hidden", "true");
  return el;
}

/** Ensure at least 4em between open and completed tasks, but only when needed. */
function syncTasksListMinGap(listEl) {
  if (!listEl) return;
  const spacer = listEl.querySelector(":scope > .tasks-list-add-spacer");
  if (!spacer) return;

  const anchor = listEl.querySelector(":scope > .task-row.task-row-completed-anchor");
  spacer.style.minHeight = "0";
  if (!anchor) return;

  const lastOpen = spacer.previousElementSibling;
  if (!lastOpen) return;

  const gapPx = anchor.offsetTop - lastOpen.offsetTop - lastOpen.offsetHeight;
  const minGapPx = parseFloat(getComputedStyle(listEl).fontSize) * 4;
  spacer.style.minHeight = gapPx + 0.5 < minGapPx ? "4em" : "0";
}

let tasksListMinGapObserver = null;

function observeTasksListMinGap(listEl) {
  if (!listEl) return;
  if (!tasksListMinGapObserver) {
    tasksListMinGapObserver = new ResizeObserver((entries) => {
      for (const entry of entries) syncTasksListMinGap(entry.target);
    });
  }
  tasksListMinGapObserver.observe(listEl);
  syncTasksListMinGap(listEl);
}

function syncTaskColorButton(btn, color) {
  if (!btn) return;
  const dot = btn.querySelector(".task-color-dot");
  if (!dot) return;
  const c = normalizeTaskColor(color);
  if (c) {
    dot.style.background = taskHighlightCssVar(c);
    dot.dataset.filled = "1";
  } else {
    dot.style.background = "";
    delete dot.dataset.filled;
  }
}

let activeColorPicker = null;
let pendingBlurCommitTimer = null;

/** >0 while a panel re-render is removing its rows. */
let taskListRerendering = 0;

/**
 * Empty a task list container. Chrome fires `blur` on the focused field while
 * it is being removed; blur handlers check `taskListRerendering` to tell that
 * apart from the user leaving the field.
 */
function clearTaskListContainer(el) {
  if (!el) return;
  taskListRerendering += 1;
  try {
    el.innerHTML = "";
  } finally {
    taskListRerendering -= 1;
  }
}

/** Defer blur→commit so mobile tap on action buttons (color, etc.) can cancel it. */
function scheduleTaskBlurCommit(commitFn, shouldSkip) {
  if (pendingBlurCommitTimer != null) {
    clearTimeout(pendingBlurCommitTimer);
  }
  pendingBlurCommitTimer = setTimeout(() => {
    pendingBlurCommitTimer = null;
    if (shouldSkip?.()) return;
    if (activeColorPicker) return;
    if (document.querySelector(".task-color-popover")) return;
    const ae = document.activeElement;
    if (ae?.closest?.(".task-row-actions")) return;
    void commitFn();
  }, 50);
}

document.addEventListener(
  "pointerdown",
  (e) => {
    if (
      e.target.closest?.(".task-row-actions") ||
      e.target.closest?.(".task-color-popover")
    ) {
      if (pendingBlurCommitTimer != null) {
        clearTimeout(pendingBlurCommitTimer);
        pendingBlurCommitTimer = null;
      }
    }
  },
  true
);

function closeTaskColorPicker(restoreFocus = false) {
  if (!activeColorPicker) return;
  const { el, onOutside, onKey, onScroll, restoreFocusInput, rowEl } = activeColorPicker;
  if (el && el.parentNode) el.parentNode.removeChild(el);
  document.removeEventListener("mousedown", onOutside, true);
  document.removeEventListener("keydown", onKey, true);
  window.removeEventListener("scroll", onScroll, true);
  window.removeEventListener("resize", onScroll, true);
  if (rowEl) rowEl.classList.remove("task-row-color-open");
  activeColorPicker = null;
  if (restoreFocus && restoreFocusInput?.isConnected) {
    restoreFocusInput.focus({ preventScroll: true });
  }
}

function syncTaskCheckboxA11y(checkbox, checked) {
  if (!checkbox) return;
  checkbox.setAttribute("role", "checkbox");
  checkbox.setAttribute("aria-checked", checked ? "true" : "false");
  checkbox.setAttribute(
    "aria-label",
    checked ? "Mark task incomplete" : "Mark task complete"
  );
}

function wireTaskColorSwatch(btn, onPick) {
  const pick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    onPick();
    closeTaskColorPicker(true);
  };
  btn.addEventListener("mousedown", pick);
  btn.addEventListener("click", pick);
}

function openTaskColorPicker(anchor, currentColor, onSelect, restoreFocusInput, rowEl) {
  closeTaskColorPicker(false);
  if (!anchor) return;

  const pop = document.createElement("div");
  pop.className = "task-color-popover";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-modal", "true");
  pop.setAttribute("aria-label", "Task color");

  const grid = document.createElement("div");
  grid.className = "task-color-grid";
  grid.setAttribute("role", "listbox");
  grid.setAttribute("aria-label", "Task colors");

  const current = normalizeTaskColor(currentColor);
  const swatches = [];

  const noneBtn = document.createElement("button");
  noneBtn.type = "button";
  noneBtn.className = "task-color-swatch task-color-swatch-none";
  noneBtn.setAttribute("role", "option");
  noneBtn.setAttribute("aria-label", "No color");
  noneBtn.setAttribute("aria-selected", !current ? "true" : "false");
  if (!current) noneBtn.classList.add("task-color-swatch-active");
  wireTaskColorSwatch(noneBtn, () => onSelect(null));
  grid.appendChild(noneBtn);
  swatches.push(noneBtn);

  for (const color of TASK_COLOR_PALETTE) {
    const s = document.createElement("button");
    s.type = "button";
    s.className = "task-color-swatch";
    s.style.background = taskHighlightCssVar(color);
    s.setAttribute("role", "option");
    s.setAttribute("aria-label", `Color ${color}`);
    s.setAttribute("aria-selected", current === color ? "true" : "false");
    if (current === color) s.classList.add("task-color-swatch-active");
    wireTaskColorSwatch(s, () => onSelect(color));
    grid.appendChild(s);
    swatches.push(s);
  }

  pop.appendChild(grid);
  document.body.appendChild(pop);

  function focusSwatch(index) {
    const i = ((index % swatches.length) + swatches.length) % swatches.length;
    swatches[i]?.focus({ preventScroll: true });
  }

  function position() {
    const rect = anchor.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    const margin = 8;
    let top = rect.bottom + 6;
    const centerEl = rowEl || anchor;
    const centerRect = centerEl.getBoundingClientRect();
    let left = centerRect.left + centerRect.width / 2 - popRect.width / 2;
    if (left < margin) left = margin;
    if (left + popRect.width > window.innerWidth - margin) {
      left = window.innerWidth - popRect.width - margin;
    }
    if (top + popRect.height > window.innerHeight - margin) {
      top = Math.max(margin, rect.top - popRect.height - 6);
    }
    pop.style.top = `${top}px`;
    pop.style.left = `${left}px`;
  }
  position();

  const onOutside = (e) => {
    if (pop.contains(e.target) || anchor.contains(e.target)) return;
    closeTaskColorPicker(true);
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      closeTaskColorPicker(true);
      return;
    }
    if (!pop.contains(e.target)) return;
    const idx = swatches.indexOf(document.activeElement);
    if (idx === -1) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      focusSwatch(idx + 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      focusSwatch(idx - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusSwatch(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusSwatch(swatches.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      document.activeElement?.click();
    }
  };
  const onScroll = () => position();

  document.addEventListener("mousedown", onOutside, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onScroll, true);

  activeColorPicker = { el: pop, onOutside, onKey, onScroll, restoreFocusInput, rowEl };

  requestAnimationFrame(() => focusSwatch(0));
}

function wireTaskDragHandle(dragHandle, row, isAuthed, onDragStart, onDragEnd, touchReorder) {
  dragHandle.draggable = false;
  if (!isAuthed) {
    row.draggable = false;
    return;
  }
  row.draggable = true;

  let restoreEditFocusInput = null;
  let reorderFromHandle = false;
  let dragImageOffsetX = 0;
  let dragImageOffsetY = 0;
  let touchPointerId = null;
  let touchTracking = false;
  let touchArmed = false;

  const beginDragInteraction = () => {
    const input = row.querySelector(".task-text");
    if (input && document.activeElement === input) {
      restoreEditFocusInput = input;
    }
    taskDragInteractionActive = true;
    row.classList.add("task-row-reorder-active");
  };

  const endDragInteraction = () => {
    taskDragInteractionActive = false;
    reorderFromHandle = false;
    row.classList.remove("task-row-reorder-active");
    const input = restoreEditFocusInput;
    restoreEditFocusInput = null;
    if (input?.isConnected) {
      requestAnimationFrame(() => {
        input.focus({ preventScroll: true });
      });
    }
  };

  const armPointerUpCleanup = () => {
    const onPointerUp = () => {
      window.removeEventListener("mouseup", onPointerUp);
      window.removeEventListener("pointerup", onPointerUp);
      requestAnimationFrame(() => {
        if (!row.classList.contains("task-row-dragging") && !touchTracking) {
          endDragInteraction();
        }
      });
    };
    window.addEventListener("mouseup", onPointerUp);
    window.addEventListener("pointerup", onPointerUp);
  };

  const onHandlePointerDown = (e) => {
    // Touch/pen use the pointer path below — avoid double-arming HTML5 drag.
    if (e.pointerType && e.pointerType !== "mouse") return;
    reorderFromHandle = true;
    const rect = row.getBoundingClientRect();
    dragImageOffsetX = e.clientX - rect.left;
    dragImageOffsetY = e.clientY - rect.top;
    beginDragInteraction();
    e.stopPropagation();
    armPointerUpCleanup();
  };

  dragHandle.addEventListener("mousedown", onHandlePointerDown, true);
  dragHandle.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  row.addEventListener("dragstart", (e) => {
    if (!reorderFromHandle) {
      e.preventDefault();
      return;
    }
    beginDragInteraction();
    row.classList.add("task-row-dragging");
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      if (e.dataTransfer.setDragImage) {
        e.dataTransfer.setDragImage(row, dragImageOffsetX, dragImageOffsetY);
      }
    }
    onDragStart(e);
  });

  row.addEventListener("dragend", () => {
    reorderFromHandle = false;
    row.classList.remove("task-row-dragging");
    endDragInteraction();
    hideAllTaskDropIndicators();
    onDragEnd();
  });

  // iOS / touch: HTML5 DnD from a handle is unreliable. Drive same-list reorder
  // with Pointer Events; desktop mouse keeps the path above.
  if (touchReorder && typeof touchReorder.commit === "function") {
    const finishTouch = (e, committed) => {
      if (!touchArmed && !touchTracking) return;
      if (touchPointerId != null && e.pointerId !== touchPointerId) return;
      try {
        dragHandle.releasePointerCapture?.(touchPointerId);
      } catch {
        /* already released */
      }
      const wasTracking = touchTracking;
      touchArmed = false;
      touchTracking = false;
      touchPointerId = null;
      // Commit while .task-row-dragging is still on — keeps the portaled
      // mobile actions panel hidden so elementFromPoint hits the list.
      if (wasTracking && committed) {
        touchReorder.commit(e.clientX, e.clientY);
      }
      row.classList.remove("task-row-dragging");
      hideAllTaskDropIndicators();
      onDragEnd();
      endDragInteraction();
    };

    dragHandle.addEventListener(
      "pointerdown",
      (e) => {
        if (!isAuthed) return;
        if (e.pointerType === "mouse") return;
        if (e.button != null && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        touchPointerId = e.pointerId;
        touchArmed = true;
        touchTracking = false;
        beginDragInteraction();
        try {
          dragHandle.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        // Seed drag state (payload / draggedId) without a real dataTransfer.
        const fakeDt = {
          effectAllowed: "move",
          setData() {},
          setDragImage() {},
        };
        onDragStart({ dataTransfer: fakeDt, preventDefault() {}, clientX: e.clientX, clientY: e.clientY });
      },
      true
    );

    dragHandle.addEventListener("pointermove", (e) => {
      if (!touchArmed || e.pointerId !== touchPointerId) return;
      if (!touchTracking) {
        touchTracking = true;
        row.classList.add("task-row-dragging");
      }
      const listEl = touchReorder.getListEl?.();
      const indicator = touchReorder.getIndicator?.();
      const anchor = touchReorder.getAnchorEl?.();
      if (listEl && indicator && anchor) {
        updateTaskDropIndicator(
          anchor,
          indicator,
          listEl,
          e,
          touchReorder.getDraggedId?.() ?? row.dataset.id,
          touchReorder.getTaskIndex
        );
      }
    });

    dragHandle.addEventListener("pointerup", (e) => finishTouch(e, true));
    dragHandle.addEventListener("pointercancel", (e) => finishTouch(e, false));
  }
}

function taskRowInsertBefore(e, row) {
  const rect = row.getBoundingClientRect();
  return e.clientY < rect.top + rect.height / 2;
}

function dataTransferHasType(dt, mime) {
  const types = dt?.types;
  if (!types) return false;
  for (let i = 0; i < types.length; i++) {
    if (types[i] === mime) return true;
  }
  return false;
}

function isActiveTaskDragEvent(e) {
  if (taskDragInteractionActive) return true;
  if (typeof window !== "undefined" && window.__dragTaskPayload != null) return true;
  const dt = e.dataTransfer;
  if (!dt) return false;
  if (dataTransferHasType(dt, ONEWEEK_DRAG_PAYLOAD_MIME)) return true;
  if (dataTransferHasType(dt, "text/plain")) return true;
  return dt.types != null && dt.types.length > 0;
}

function createTaskDropIndicator(anchorEl, scrollEl = anchorEl) {
  const ensureIndicator = () => {
    let indicator = anchorEl.querySelector(":scope > .task-drop-indicator");
    if (!indicator?.isConnected) {
      indicator = document.createElement("div");
      indicator.className = "task-drop-indicator";
      indicator.setAttribute("aria-hidden", "true");
      indicator.hidden = true;
      anchorEl.appendChild(indicator);
    }
    return indicator;
  };

  const placeAtClientY = (clientY) => {
    const indicator = ensureIndicator();
    const anchorRect = anchorEl.getBoundingClientRect();
    const top =
      scrollEl === anchorEl
        ? clientY - anchorRect.top + scrollEl.scrollTop
        : clientY - anchorRect.top;
    indicator.style.top = `${top}px`;
    indicator.hidden = false;
  };

  return {
    showBeforeRow(row) {
      placeAtClientY(row.getBoundingClientRect().top);
    },
    showAfterRow(row) {
      placeAtClientY(row.getBoundingClientRect().bottom);
    },
    showAtEnd(listEl) {
      const rows = listEl.querySelectorAll(".task-row:not(.task-row-dragging)");
      if (rows.length) {
        placeAtClientY(rows[rows.length - 1].getBoundingClientRect().bottom);
      } else {
        placeAtClientY(listEl.getBoundingClientRect().top + 4);
      }
    },
    hide() {
      ensureIndicator().hidden = true;
    },
  };
}

function hideAllTaskDropIndicators() {
  document.querySelectorAll(".task-drop-indicator").forEach((el) => {
    el.hidden = true;
  });
  document.getElementById("main-thing")?.classList.remove("is-drop-target");
}

function updateTaskDropIndicator(anchorEl, indicator, listEl, e, draggedRowId, getTaskIndex) {
  if (!listEl) {
    indicator.hide();
    return;
  }

  const row = e.target.closest?.(".task-row");
  if (!row || !listEl.contains(row)) {
    indicator.showAtEnd(listEl);
    return;
  }

  const insertBefore = taskRowInsertBefore(e, row);
  const rowId = row.dataset.id;
  if (rowId && rowId === draggedRowId) {
    const from = getTaskIndex(rowId);
    if (from >= 0) {
      const insertAt = computeReorderInsertIndex(from, from, insertBefore);
      if (insertAt === from) {
        indicator.hide();
        return;
      }
    }
  }

  if (insertBefore) indicator.showBeforeRow(row);
  else indicator.showAfterRow(row);
}

if (typeof document !== "undefined") {
  document.addEventListener("dragend", hideAllTaskDropIndicators);
}

/**
 * Compute where to insert a task dragged in from another block, based on the
 * cursor position. Honours the "unchecked above, checked below" partition: an
 * unchecked task can only land in the unchecked segment; a checked one only
 * in the checked segment. If the cursor is in the wrong segment, snap to the
 * nearest boundary inside the allowed segment.
 */
function computeCrossInsertIndex(tasks, getTaskIndex, e, listEl, payloadChecked) {
  const len = tasks.length;
  const firstChecked = firstCheckedTaskIndex(tasks);
  const segStart = payloadChecked ? (firstChecked === -1 ? len : firstChecked) : 0;
  const segEnd = payloadChecked ? len : (firstChecked === -1 ? len : firstChecked);

  const row = e.target.closest?.(".task-row");
  if (!row || !listEl?.contains(row)) {
    return payloadChecked ? len : (firstChecked === -1 ? len : firstChecked);
  }
  const id = row.dataset?.id;
  const targetIdx = id ? getTaskIndex(id) : -1;
  if (targetIdx < 0) {
    return payloadChecked ? len : (firstChecked === -1 ? len : firstChecked);
  }
  const insertBefore = taskRowInsertBefore(e, row);
  let insertAt = insertBefore ? targetIdx : targetIdx + 1;
  if (insertAt < segStart) insertAt = segStart;
  if (insertAt > segEnd) insertAt = segEnd;
  return insertAt;
}

/**
 * Place the drop indicator at the would-be insert position for a cross-block
 * drag. `insertAt === tasks.length` means "after the very last row".
 */
function showCrossDropIndicator(indicator, listEl, insertAt, tasks) {
  if (!listEl) {
    indicator.hide();
    return;
  }
  const rows = listEl.querySelectorAll(".task-row:not(.task-row-dragging)");
  const visibleIdx = tasks
    ? visibleRowIndexForFlatInsert(tasks, insertAt)
    : insertAt;
  if (visibleIdx >= rows.length) {
    indicator.showAtEnd(listEl);
    return;
  }
  indicator.showBeforeRow(rows[Math.max(0, visibleIdx)]);
}

/**
 * One Supabase write for cross-panel moves (type + day + content in one request).
 * Do not require `.select()` after update: RLS often allows UPDATE but not returning rows,
 * which yields empty `data` with no `error` — that previously blocked the UI incorrectly.
 */
async function supabaseRelocateTaskRow(supabase, userId, rowId, fields) {
  if (!supabase || !userId || rowId == null) {
    return { ok: false, error: new Error("supabaseRelocateTaskRow: missing client, user, or row id") };
  }
  const update = {
    type: fields.type,
    day_name: fields.day_name ?? null,
    date: fields.date,
    content: String(fields.content ?? ""),
    completed: !!fields.completed,
    is_subtask: !!fields.is_subtask,
    color: normalizeTaskColor(fields.color),
  };
  if (fields.workspace_id) update.workspace_id = fields.workspace_id;
  if (typeof fields.position === "number") update.position = fields.position;
  if (typeof fields.is_main === "boolean") update.is_main = fields.is_main;
  const { error } = await supabase
    .from("tasks")
    .update(update)
    .eq("id", rowId)
    .eq("user_id", userId);
  if (error) return { ok: false, error };
  return { ok: true, error: null };
}

function persistSubtaskNormalizationFixes(changed, { markTaskDirty, persistTask } = {}) {
  if (!changed?.length || !markTaskDirty || !persistTask) return;
  for (const t of changed) {
    if (!t?.dbId || isTaskEmptyText(t.text)) continue;
    markTaskDirty(t);
    void persistTask(t);
  }
}

function isTabNavigationKey(e) {
  return e.key === "Tab" || e.code === "Tab" || e.keyCode === 9;
}

/** Tab indents; Shift+Tab outdents. Meta/Ctrl+Tab left for the browser. */
function isTaskIndentKey(e) {
  return isTabNavigationKey(e) && !e.metaKey && !e.ctrlKey && !e.altKey;
}

function handleTaskTextTabIndent(e, ctx) {
  const {
    tasks,
    taskId,
    getTaskIndex,
    persistTask,
    markTaskDirty,
    schedulePersistTaskPositions,
    render,
    isTaskEmptyText: isEmpty = isTaskEmptyText,
  } = ctx;
  if (!isTaskIndentKey(e)) return false;
  const idx = getTaskIndex(taskId);
  if (idx === -1) return false;
  const task = tasks[idx];
  const willOutdent = !!e.shiftKey;
  if (willOutdent) {
    if (!task.subtask) return false;
  } else if (!canIndentAsSubtask(tasks, idx)) {
    return false;
  }
  e.preventDefault();
  e.stopImmediatePropagation();
  const input = e.target;
  applyTaskSubtaskIndent(tasks, idx, { outdent: willOutdent });
  const fixed = normalizeSubtaskFlags(tasks);
  persistSubtaskNormalizationFixes(fixed, ctx);
  if (!isEmpty(task.text)) {
    markTaskDirty(task);
    void persistTask(task);
  }
  if (typeof ctx.reorder === "function") ctx.reorder(tasks);
  schedulePersistTaskPositions();
  if (ctx.setFocusAfterRender) {
    ctx.setFocusAfterRender({
      id: task.id,
      start: input.selectionStart,
      end: input.selectionEnd,
    });
  }
  render();
  return true;
}

function applyTaskIndentFromButton(ctx, taskId) {
  const {
    tasks,
    getTaskIndex,
    persistTask,
    markTaskDirty,
    schedulePersistTaskPositions,
    render,
    isTaskEmptyText: isEmpty = isTaskEmptyText,
  } = ctx;
  const idx = getTaskIndex(taskId);
  if (idx === -1) return;
  const task = tasks[idx];
  const changed = applyTaskSubtaskIndent(tasks, idx, { outdent: !!task.subtask });
  if (!changed) return;
  const fixed = normalizeSubtaskFlags(tasks);
  persistSubtaskNormalizationFixes(fixed, ctx);
  if (!isEmpty(task.text)) {
    markTaskDirty(task);
    void persistTask(task);
  }
  if (typeof ctx.reorder === "function") ctx.reorder(tasks);
  schedulePersistTaskPositions();
  if (ctx.setFocusAfterRender) {
    ctx.setFocusAfterRender({ id: task.id });
  }
  render();
}

/**
 * Map a flat-array insert index to a visible-row index (collapsed subtasks are
 * skipped in the DOM but still occupy flat-array slots).
 */
function visibleRowIndexForFlatInsert(tasks, insertAt) {
  if (!tasks?.length) return 0;
  const clamped = Math.max(0, Math.min(insertAt, tasks.length));
  let visibleBefore = 0;
  for (let i = 0; i < clamped; i++) {
    if (!isSubtaskRowHidden(tasks, i)) visibleBefore++;
  }
  if (clamped < tasks.length && isSubtaskRowHidden(tasks, clamped)) {
    for (let i = clamped; i < tasks.length; i++) {
      if (!isSubtaskRowHidden(tasks, i)) return visibleBefore;
    }
  }
  return visibleBefore;
}

function focusTaskRowForEdit(row, preferTarget) {
  if (!row) return;
  if (preferTarget?.classList?.contains("task-text")) {
    preferTarget.focus();
    return;
  }
  const input = row.querySelector(".task-text");
  if (input) input.focus();
}

function isTaskRowActionTarget(e) {
  return (
    e.target.classList?.contains("task-commit") ||
    e.target.classList?.contains("task-delete") ||
    !!e.target.closest?.(".task-color") ||
    !!e.target.closest?.(".task-star") ||
    !!e.target.closest?.(".task-indent") ||
    e.target.classList?.contains("task-drag-handle") ||
    e.target.classList?.contains("task-drag-handle-icon") ||
    !!e.target.closest?.(".task-drag-handle") ||
    !!e.target.closest?.(".task-subtask-toggle-wrap")
  );
}

let pendingTaskDeleteChain = Promise.resolve();

function trackPendingTaskDeletes(promise) {
  pendingTaskDeleteChain = pendingTaskDeleteChain
    .then(() => promise)
    .catch(() => {});
}

async function awaitPendingTaskDeletes() {
  await pendingTaskDeleteChain;
}

async function taskRowExistsInDb(supabase, userId, dbId) {
  if (!supabase || !userId || !dbId) return false;
  const { data, error } = await supabase
    .from("tasks")
    .select("id")
    .eq("id", dbId)
    .eq("user_id", userId)
    .maybeSingle();
  return !error && !!data;
}

/** Relocate cross-panel subtree rows; revert any successful writes on failure. */
async function relocateCrossMoveSubtree(
  supabase,
  userId,
  payload,
  targetRelocate,
  startPosition,
  { normalizeContent } = {}
) {
  const rows = crossMovePayloadRows(payload);
  const sourceRelocate = payload?.sourceRelocate;
  const reverted = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.dbId) continue;
    const content = normalizeContent
      ? normalizeContent(String(row.text ?? ""))
      : String(row.text ?? "");
    const { ok, error } = await supabaseRelocateTaskRow(supabase, userId, row.dbId, {
      type: targetRelocate.type,
      day_name: targetRelocate.day_name ?? null,
      date: targetRelocate.date,
      workspace_id: targetRelocate.workspace_id,
      content,
      completed: !!row.checked,
      is_subtask: !!row.subtask,
      color: normalizeTaskColor(row.color),
      position: startPosition + i,
      is_main: !!(targetRelocate.is_main && i === 0 && !row.subtask),
    });
    if (!ok) {
      for (let j = reverted.length - 1; j >= 0; j--) {
        const prev = reverted[j];
        await supabaseRelocateTaskRow(supabase, userId, prev.dbId, prev.sourceFields);
      }
      return { ok: false, error };
    }
    if (sourceRelocate?.rows) {
      const src =
        sourceRelocate.rows.find((r) => r.dbId === row.dbId) ||
        sourceRelocate.rows[i];
      if (src?.dbId) {
        reverted.push({
          dbId: src.dbId,
          sourceFields: {
            type: sourceRelocate.type,
            day_name: sourceRelocate.day_name ?? null,
            date: sourceRelocate.date,
            workspace_id: sourceRelocate.workspace_id,
            content: src.content ?? String(row.text ?? ""),
            completed: src.completed ?? !!row.checked,
            is_subtask: src.is_subtask ?? !!row.subtask,
            color: normalizeTaskColor(src.color ?? row.color),
            position: src.position ?? startPosition + i,
          },
        });
      }
    }
  }
  return { ok: true, error: null };
}

if (typeof window !== "undefined") {
  window.__crossMoveBackups = window.__crossMoveBackups || new Map();
}

function storeCrossMoveSourceBackup(sourceLocalId, position, snapshots) {
  if (typeof window === "undefined") return;
  window.__crossMoveBackups.set(sourceLocalId, { position, snapshots });
}

function takeCrossMoveSourceBackup(sourceLocalId) {
  if (typeof window === "undefined") return null;
  const backup = window.__crossMoveBackups.get(sourceLocalId);
  window.__crossMoveBackups.delete(sourceLocalId);
  return backup || null;
}

function rollbackCrossMoveOnTarget(state, insertedLocalIds) {
  for (let i = insertedLocalIds.length - 1; i >= 0; i--) {
    const idx = state.tasks.findIndex((t) => t.id === insertedLocalIds[i]);
    if (idx !== -1) state.tasks.splice(idx, 1);
  }
}

function reorderSubtreeFromSameListDrop(tasks, fromId, e, listEl, getTaskIndex) {
  const from = getTaskIndex(fromId);
  if (from === -1) return null;

  const row = e.target.closest?.(".task-row");
  if (
    row &&
    listEl?.contains(row) &&
    !row.classList.contains("task-row-dragging") &&
    row.dataset.id &&
    row.dataset.id !== fromId
  ) {
    const to = getTaskIndex(row.dataset.id);
    if (to === -1) return null;
    return reorderSubtreeInArray(tasks, from, to, taskRowInsertBefore(e, row));
  }

  return reorderSubtreeToListEnd(tasks, from);
}

/** Touch pointer drop: resolve target row under the finger (or end of list). */
function reorderSubtreeFromTouchPoint(tasks, fromId, clientX, clientY, listEl, getTaskIndex) {
  const from = getTaskIndex(fromId);
  if (from === -1) return null;
  const hit = document.elementFromPoint(clientX, clientY);
  const row = hit?.closest?.(".task-row");
  if (
    row &&
    listEl?.contains(row) &&
    !row.classList.contains("task-row-dragging") &&
    row.dataset.id &&
    row.dataset.id !== fromId
  ) {
    const to = getTaskIndex(row.dataset.id);
    if (to === -1) return null;
    return reorderSubtreeInArray(
      tasks,
      from,
      to,
      taskRowInsertBefore({ clientY }, row)
    );
  }
  return reorderSubtreeToListEnd(tasks, from);
}

const collapsedSubtaskParents = new Set();

function collapseKeyForTask(task) {
  if (!task) return null;
  if (task.dbId != null) return `db:${task.dbId}`;
  return `local:${task.id}`;
}

function isTaskCollapsed(task) {
  const key = collapseKeyForTask(task);
  return key != null && collapsedSubtaskParents.has(key);
}

function setTaskCollapsed(task, collapsed) {
  const key = collapseKeyForTask(task);
  if (!key) return;
  if (collapsed) collapsedSubtaskParents.add(key);
  else collapsedSubtaskParents.delete(key);
}

function collapsedSubtasksStorageKey(workspaceId) {
  return `oneweek-collapsed-subs-${workspaceId || "none"}`;
}

function readCollapsedSubtaskDbIds(workspaceId) {
  try {
    const raw = localStorage.getItem(collapsedSubtasksStorageKey(workspaceId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.map(String).filter(Boolean));
  } catch {
    return new Set();
  }
}

function writeCollapsedSubtaskDbIds(workspaceId, dbIds) {
  if (!workspaceId) return;
  try {
    const key = collapsedSubtasksStorageKey(workspaceId);
    if (!dbIds || dbIds.size === 0) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, JSON.stringify([...dbIds]));
  } catch {
    /* storage blocked */
  }
}

/** Restore collapse UI state from persisted parent dbIds for this workspace. */
function syncCollapsedSubtasksFromStorage(tasks, workspaceId) {
  if (!tasks?.length) return;
  const dbIds = workspaceId ? readCollapsedSubtaskDbIds(workspaceId) : new Set();
  for (const t of tasks) {
    if (!t || t.subtask) continue;
    const key = collapseKeyForTask(t);
    if (!key || t.dbId == null) continue;
    if (dbIds.has(String(t.dbId))) collapsedSubtaskParents.add(key);
    else collapsedSubtaskParents.delete(key);
  }
}

/** Drop collapse entries for deleted mains and stale dbIds no longer on the board. */
function pruneCollapsedSubtaskStorage(tasks, removedTasks, workspaceId) {
  if (!workspaceId) return;
  const existing = readCollapsedSubtaskDbIds(workspaceId);
  let changed = false;

  for (const t of removedTasks || []) {
    if (!t || t.subtask || t.dbId == null) continue;
    const dbKey = String(t.dbId);
    if (existing.has(dbKey)) {
      existing.delete(dbKey);
      changed = true;
    }
    collapsedSubtaskParents.delete(collapseKeyForTask(t));
  }

  const liveDbIds = new Set(
    (tasks || [])
      .filter((t) => !t.subtask && t.dbId != null)
      .map((t) => String(t.dbId))
  );
  for (const dbKey of existing) {
    if (!liveDbIds.has(dbKey)) {
      existing.delete(dbKey);
      changed = true;
    }
  }

  if (changed) writeCollapsedSubtaskDbIds(workspaceId, existing);
}

/** Persist collapse for the given panel's tasks (merge into workspace store). */
function persistCollapsedSubtasksToStorage(tasks, workspaceId) {
  if (!workspaceId || !tasks) return;
  const existing = readCollapsedSubtaskDbIds(workspaceId);
  for (const t of tasks) {
    if (!t || t.subtask || t.dbId == null) continue;
    const key = String(t.dbId);
    if (isTaskCollapsed(t)) existing.add(key);
    else existing.delete(key);
  }
  writeCollapsedSubtaskDbIds(workspaceId, existing);
}

function isSubtaskRowHidden(tasks, idx) {
  const task = tasks[idx];
  if (!task?.subtask) return false;
  const parentIdx = getParentMainTaskIndex(tasks, idx);
  if (parentIdx < 0) return false;
  return isTaskCollapsed(tasks[parentIdx]);
}

function createSubtaskToggle(mainTask, subtaskCount, onToggle) {
  const wrap = document.createElement("div");
  wrap.className = "task-subtask-toggle-wrap";

  const countEl = document.createElement("span");
  countEl.className = "task-subtask-count";
  countEl.textContent = String(subtaskCount);
  countEl.setAttribute("aria-hidden", "true");

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "task-subtask-toggle";
  const collapseKey = collapseKeyForTask(mainTask);
  const collapsed = collapseKey != null && collapsedSubtaskParents.has(collapseKey);
  if (collapsed) {
    btn.classList.add("is-collapsed");
    wrap.classList.add("is-collapsed");
  }
  btn.setAttribute(
    "aria-label",
    collapsed
      ? `Show ${subtaskCount} subtask${subtaskCount === 1 ? "" : "s"}`
      : "Hide subtasks"
  );
  btn.setAttribute("aria-expanded", String(!collapsed));
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!collapseKey) return;
    if (collapsedSubtaskParents.has(collapseKey)) {
      collapsedSubtaskParents.delete(collapseKey);
    } else {
      collapsedSubtaskParents.add(collapseKey);
    }
    onToggle();
  });

  wrap.appendChild(countEl);
  wrap.appendChild(btn);
  return wrap;
}

(() => {
  const weekdayToIndex = {
    Monday: 0,
    Tuesday: 1,
    Wednesday: 2,
    Thursday: 3,
    Friday: 4,
    Saturday: 5,
    Sunday: 6,
  };

  function updateDayOfMonthLabels() {
    const weekStart = getVisibleWeekStartDate();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const onThisWeek = Number(window.__weekOffset || 0) === 0;

    const dayRects = document.querySelectorAll(".day-rect[data-day]");
    dayRects.forEach((rect) => {
      const dayName = rect.dataset.day;
      const dayIndex = weekdayToIndex[dayName];
      if (dayIndex == null) {
        rect.classList.remove("is-today");
        return; // skip "Next week"
      }

      const date = new Date(weekStart);
      date.setDate(weekStart.getDate() + dayIndex);
      date.setHours(0, 0, 0, 0);

      const label = rect.querySelector(".day-label");
      if (!label) return;
      label.textContent = `${dayName}, ${date.getDate()}`;
      rect.classList.toggle(
        "is-today",
        onThisWeek && date.getTime() === today.getTime()
      );
    });
  }

  function scheduleNextUpdate() {
    updateDayOfMonthLabels();

    const now = new Date();
    const next = new Date(now);
    next.setHours(24, 0, 0, 0); // local midnight
    const delayMs = next.getTime() - now.getTime();

    window.setTimeout(scheduleNextUpdate, delayMs + 50);
  }

  function syncWeekAwayClass() {
    document.body.classList.toggle(
      "week-offset-away",
      Number(window.__weekOffset || 0) !== 0
    );
  }

  /**
   * Re-trigger the CSS week-switch animation. We toggle a class via
   * `force reflow → add` so the animation restarts cleanly even when the
   * user mashes the week arrows.
   */
  function playWeekSwitchAnimation() {
    const layout = document.querySelector(".layout");
    if (!layout) return;
    layout.classList.remove("is-week-switching");
    void layout.offsetWidth;
    layout.classList.add("is-week-switching");
    window.clearTimeout(playWeekSwitchAnimation._timer);
    playWeekSwitchAnimation._timer = window.setTimeout(() => {
      layout.classList.remove("is-week-switching");
    }, 320);
  }

  function shiftWeek(delta) {
    void (async () => {
      await flushAllTaskSaves();
      window.__weekOffset = Number(window.__weekOffset || 0) + delta;
      syncWeekAwayClass();
      updateDayOfMonthLabels();
      updateWeekNavLabel();
      renderWeeksList();
      playWeekSwitchAnimation();
      window.dispatchEvent(new CustomEvent(WEEK_CHANGE_EVENT));
    })();
  }

  function setWeekOffset(offset) {
    void (async () => {
      await flushAllTaskSaves();
      const previous = Number(window.__weekOffset || 0);
      window.__weekOffset = offset;
      syncWeekAwayClass();
      updateDayOfMonthLabels();
      updateWeekNavLabel();
      renderWeeksList();
      if (previous !== offset) playWeekSwitchAnimation();
      window.dispatchEvent(new CustomEvent(WEEK_CHANGE_EVENT));
    })();
  }

  const MONTH_NAMES = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];

  function formatWeekLabel(mondayDate) {
    const mon = new Date(mondayDate);
    const sun = new Date(mon);
    sun.setDate(sun.getDate() + 6);
    const d1 = mon.getDate();
    const m1 = MONTH_NAMES[mon.getMonth()];
    const d2 = sun.getDate();
    const m2 = MONTH_NAMES[sun.getMonth()];
    return `${d1} ${m1} — ${d2} ${m2}`;
  }

  function getWeekNavLabel(offset) {
    if (offset === 0) return "this week";
    if (offset === 1) return "next week";
    if (offset === -1) return "last week";
    return formatWeekLabel(getWeekMondayStart(new Date(), offset));
  }

  const weekNavLabel = document.getElementById("week-nav-label");
  const weekGoThisWeekBtn = document.getElementById("week-go-this-week");

  function updateWeekNavLabel() {
    const offset = Number(window.__weekOffset || 0);
    if (weekNavLabel) weekNavLabel.textContent = getWeekNavLabel(offset);
    if (weekGoThisWeekBtn) weekGoThisWeekBtn.hidden = offset === 0;
  }

  const PAST_WEEKS_COUNT = 12;
  const weeksList = document.getElementById("weeks-list");

  function renderWeeksList() {
    if (!weeksList) return;
    const currentOffset = Number(window.__weekOffset || 0);
    weeksList.innerHTML = "";

    for (let offset = 1; offset >= -PAST_WEEKS_COUNT; offset--) {
      const monday = getWeekMondayStart(new Date(), offset);
      const dateLabel = formatWeekLabel(monday);
      const li = document.createElement("li");

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "weeks-list-btn";
      if (offset === currentOffset) {
        btn.classList.add("week-active");
        btn.setAttribute("aria-current", "true");
      }

      const dates = document.createElement("span");
      dates.className = "weeks-list-dates";
      dates.textContent = dateLabel;
      btn.appendChild(dates);

      let tagText = null;
      if (offset === 0) tagText = "now";
      else if (offset === 1) tagText = "next week";
      else if (offset === -1) tagText = "last week";

      if (tagText) {
        const tag = document.createElement("span");
        tag.className = "weeks-list-tag";
        tag.textContent = tagText;
        btn.appendChild(tag);
      }

      btn.addEventListener("click", () => setWeekOffset(offset));
      li.appendChild(btn);
      weeksList.appendChild(li);
    }
  }

  const prevBtn = document.getElementById("week-prev");
  const nextBtn = document.getElementById("week-next");
  if (prevBtn) prevBtn.addEventListener("click", () => shiftWeek(-1));
  if (nextBtn) nextBtn.addEventListener("click", () => shiftWeek(1));
  if (weekGoThisWeekBtn) {
    weekGoThisWeekBtn.addEventListener("click", () => setWeekOffset(0));
  }

  syncWeekAwayClass();
  updateWeekNavLabel();
  scheduleNextUpdate();
  renderWeeksList();
})();

async function logout() {
  const supabase = window.supabaseClient;
  if (!supabase) {
    console.error("Supabase client missing.");
    return { ok: false, error: "Auth client not initialized." };
  }

  // Drop focus so a still-typed value isn't lost when DOM is wiped after sign out.
  const active = document.activeElement;
  if (active && typeof active.blur === "function") active.blur();

  // Persist anything that's still in-flight before the session goes away.
  try {
    await flushAllTaskSaves();
  } catch (err) {
    console.error("Pre-logout flush failed:", err);
  }

  const { error } = await supabase.auth.signOut();
  if (error) {
    console.error("Sign out failed:", error);
    return { ok: false, error: "Logout failed." };
  }
  clearAllTasksCaches();
  return { ok: true };
}

window.addEventListener("load", () => {
  const overlay = document.getElementById("auth-overlay");
  const authTriggers = document.querySelectorAll("#auth-trigger-mobile");
  const closeBtn = document.getElementById("auth-close");
  const openSignInBtn = document.getElementById("auth-open-signin");
  const logoutBtn = document.getElementById("logout-button");
  const authStatusEl = document.getElementById("auth-status");
  const authMessageEl = document.getElementById("auth-message");

  function setAuthMessage(text, isError = false) {
    if (!authMessageEl) return;
    authMessageEl.textContent = text || "";
    authMessageEl.style.color = isError ? "var(--color-text)" : "inherit";
    authMessageEl.style.opacity = text ? "1" : "0.85";
  }

  function setAuthPending(isPending) {
    if (openSignInBtn) openSignInBtn.disabled = isPending;
    if (logoutBtn) logoutBtn.disabled = isPending;
  }

  async function runAuthAction(pendingText, actionFn, successText) {
    setAuthPending(true);
    setAuthMessage(pendingText);
    const res = await actionFn();
    setAuthPending(false);
    if (!res?.ok) {
      setAuthMessage(res?.error || "Operation failed.", true);
      return false;
    }
    setAuthMessage(successText);
    closeAuthPopup();
    return true;
  }

  const authGuestPanel = document.getElementById("auth-account-guest");
  const authSignedInPanel = document.getElementById("auth-account-signed-in");

  function setAuthAccountPanels(loggedIn) {
    if (authGuestPanel) authGuestPanel.hidden = loggedIn;
    if (authSignedInPanel) authSignedInPanel.hidden = !loggedIn;
  }

  async function refreshAuthStatus() {
    if (!authStatusEl) return;
    const supabase = window.supabaseClient;
    if (!supabase) {
      authStatusEl.textContent = "";
      setAuthAccountPanels(false);
      return;
    }
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const email = session?.user?.email?.trim();
    const loggedIn = Boolean(email);
    setAuthAccountPanels(loggedIn);
    if (email) {
      authStatusEl.textContent = `Logged in as ${email}`;
    } else {
      authStatusEl.textContent = "Not logged in";
    }
  }

  window.oneweekAuth.subscribe(() => {
    void refreshAuthStatus();
  });

  const themeInputText = document.getElementById("theme-color-text");
  const themeInputBg = document.getElementById("theme-color-background");
  const themeFontSelect = document.getElementById("theme-font");
  const themeApplyBtn = document.getElementById("theme-apply");
  const themeSelect = document.getElementById("theme-select");
  const themeCustomFields = document.getElementById("theme-custom-fields");
  const themeDeleteBtn = document.getElementById("theme-delete");
  const themeCustomName = document.getElementById("theme-custom-name");

  let editingCustomThemeId = null;
  const DEFAULT_THEME_KEY = window.oneweekTheme?.DEFAULT_THEME_KEY || "auto";

  function getThemePresets() {
    return themeApi()?.PRESETS || {};
  }

  function themeApi() {
    return window.oneweekTheme;
  }

  function getSelectedThemeKey() {
    return themeApi()?.getSelectedThemeKey() ?? DEFAULT_THEME_KEY;
  }

  function setSelectedThemeKey(key) {
    themeApi()?.setSelectedThemeKey(key);
  }

  function customThemeLabel(theme) {
    return theme.name || `Custom (${theme.text} / ${theme.bg})`;
  }

  function buildThemeFontOptions() {
    const tw = window.oneweekTheme;
    if (!themeFontSelect || !tw?.GOOGLE_FONTS) return;
    themeFontSelect.innerHTML = "";
    for (const font of tw.GOOGLE_FONTS) {
      const opt = document.createElement("option");
      opt.value = font.id;
      opt.textContent = font.label;
      themeFontSelect.appendChild(opt);
    }
  }

  function buildThemeOptions() {
    if (!themeSelect) return;
    const tw = themeApi();
    themeSelect.innerHTML = "";
    const autoOpt = document.createElement("option");
    autoOpt.value = tw?.AUTO_THEME_KEY || "auto";
    autoOpt.textContent = "Match device";
    themeSelect.appendChild(autoOpt);
    for (const [key, preset] of Object.entries(getThemePresets())) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = preset.label || key;
      themeSelect.appendChild(opt);
    }
    const customs = tw ? tw.getCustomThemes() : [];
    for (const theme of customs) {
      const opt = document.createElement("option");
      opt.value = tw.customThemeSelectKey(theme.id);
      opt.textContent = customThemeLabel(theme);
      themeSelect.appendChild(opt);
    }
    const ownOpt = document.createElement("option");
    ownOpt.value = "own";
    ownOpt.textContent = "Own...";
    themeSelect.appendChild(ownOpt);
  }

  const themeDeleteActions = themeDeleteBtn
    ? themeDeleteBtn.closest(".sidebar-actions")
    : null;

  function updateThemeDeleteVisibility(key) {
    const tw = themeApi();
    const resolvedKey = themeSelect?.value || key;
    const show =
      !!tw &&
      tw.isCustomThemeKey(resolvedKey) &&
      !!tw.findCustomTheme(tw.customThemeIdFromKey(resolvedKey));
    if (themeDeleteBtn) themeDeleteBtn.hidden = !show;
    if (themeDeleteActions) themeDeleteActions.hidden = !show;
  }

  function applyThemeByKey(key) {
    const tw = themeApi();
    if (!tw) return;
    tw.applyThemeKey(key);
    setSelectedThemeKey(key);
  }

  function fillThemeFormFromTheme(theme) {
    const tw = themeApi();
    if (!tw || !themeInputText || !themeInputBg) return;
    themeInputText.value = theme.text;
    themeInputBg.value = theme.bg;
    if (themeCustomName) themeCustomName.value = theme.name || "";
    if (themeFontSelect) themeFontSelect.value = theme.fontId || "";
    tw.applyThemeToDocument(theme.text, theme.bg, theme.fontId || "");
  }

  function fillThemeFormForOwnMode(previousKey) {
    const tw = themeApi();
    if (!tw) return;
    if (tw.isCustomThemeKey(previousKey)) {
      const id = tw.customThemeIdFromKey(previousKey);
      const theme = tw.findCustomTheme(id);
      if (theme) {
        editingCustomThemeId = id;
        fillThemeFormFromTheme(theme);
        return;
      }
    }
    editingCustomThemeId = null;
    if (themeCustomName) themeCustomName.value = "";
    syncThemeInputs();
  }

  function syncThemeInputs() {
    const tw = themeApi();
    if (!tw || !themeInputText || !themeInputBg) return;
    themeInputText.value = tw.getCurrentHexForInput(
      "--color-text",
      tw.THEME_STORAGE_TEXT,
      tw.DEFAULT_TEXT
    );
    themeInputBg.value = tw.getCurrentHexForInput(
      "--color-background",
      tw.THEME_STORAGE_BG,
      tw.DEFAULT_BG
    );
    if (themeFontSelect) {
      themeFontSelect.value = tw.getStoredCustomFontId();
    }
  }

  function resolveThemeKey(key) {
    return themeApi()?.isKnownThemeKey(key) ? key : DEFAULT_THEME_KEY;
  }

  function syncThemeSelect() {
    if (!themeSelect) return;
    const tw = themeApi();
    let key = resolveThemeKey(getSelectedThemeKey());
    const stored = getSelectedThemeKey();
    if (key !== stored) {
      setSelectedThemeKey(key);
    }
    buildThemeOptions();
    themeSelect.value = key;
    if (!themeSelect.value) {
      key = DEFAULT_THEME_KEY;
      themeSelect.value = key;
      setSelectedThemeKey(key);
    }
    if (themeCustomFields) themeCustomFields.hidden = key !== "own";
    if (key !== "own") editingCustomThemeId = null;
    updateThemeDeleteVisibility(themeSelect.value || key);
    if (key === "own") fillThemeFormForOwnMode(getSelectedThemeKey());
    else syncThemeInputs();
  }

  const sidebar = document.getElementById("sidebar");
  let authPopupReturnFocus = null;

  function getSidebarFocusables() {
    if (!sidebar || sidebar.hidden) return [];
    return [...sidebar.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )].filter((el) => el.offsetParent !== null);
  }

  function trapSidebarFocus(e) {
    if (!sidebar || sidebar.hidden) return;
    if (e.key !== "Tab") return;
    const focusables = getSidebarFocusables();
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function onSidebarKeydown(e) {
    if (!sidebar || sidebar.hidden) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeAuthPopup();
    }
  }

  function openAuthPopup() {
    if (!overlay || !sidebar) return;
    authPopupReturnFocus = document.activeElement;
    overlay.hidden = false;
    sidebar.hidden = false;
    sidebar.setAttribute("aria-modal", "true");
    sidebar.setAttribute("role", "dialog");
    setAuthMessage("");
    syncThemeSelect();
    void refreshAuthStatus();
    const focusables = getSidebarFocusables();
    const toFocus =
      closeBtn && focusables.includes(closeBtn) ? closeBtn : focusables[0];
    if (toFocus) toFocus.focus();
  }

  function closeAuthPopup() {
    if (!overlay || !sidebar) return;
    overlay.hidden = true;
    sidebar.hidden = true;
    sidebar.removeAttribute("aria-modal");
    sidebar.removeAttribute("role");
    const returnTo = authPopupReturnFocus;
    authPopupReturnFocus = null;
    if (returnTo && typeof returnTo.focus === "function") returnTo.focus();
  }

  authTriggers.forEach((btn) => {
    if (btn) btn.addEventListener("click", openAuthPopup);
  });
  if (closeBtn) closeBtn.addEventListener("click", closeAuthPopup);

  if (overlay) {
    overlay.addEventListener("click", closeAuthPopup);
  }

  document.addEventListener("keydown", onSidebarKeydown);
  if (sidebar) sidebar.addEventListener("keydown", trapSidebarFocus);

  if (openSignInBtn) {
    openSignInBtn.addEventListener("click", () => {
      closeAuthPopup();
      if (typeof window.oneweekOpenGuestAuth === "function") {
        window.oneweekOpenGuestAuth();
      }
    });
  }

  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      await runAuthAction("Logging out...", logout, "Logged out.");
    });
  }

  if (themeSelect) {
    themeSelect.addEventListener("change", () => {
      const key = themeSelect.value;
      if (key === "own") {
        if (themeCustomFields) themeCustomFields.hidden = false;
        fillThemeFormForOwnMode(getSelectedThemeKey());
        updateThemeDeleteVisibility(key);
        setSelectedThemeKey("own");
        return;
      }
      editingCustomThemeId = null;
      if (themeCustomFields) themeCustomFields.hidden = true;
      updateThemeDeleteVisibility(key);
      applyThemeByKey(key);
    });
  }

  function previewCustomTheme() {
    const tw = window.oneweekTheme;
    if (!tw || !themeInputText || !themeInputBg) return;
    const nt = tw.normalizeHexColor(themeInputText.value);
    const nb = tw.normalizeHexColor(themeInputBg.value);
    const fontId = themeFontSelect ? themeFontSelect.value : "";
    if (nt && nb) {
      tw.applyThemeToDocument(nt, nb, fontId);
    }
  }

  if (themeInputText) themeInputText.addEventListener("input", previewCustomTheme);
  if (themeInputBg) themeInputBg.addEventListener("input", previewCustomTheme);
  if (themeFontSelect) themeFontSelect.addEventListener("change", previewCustomTheme);

  (function setupThemeColorPicker() {
    const picker = document.getElementById("theme-color-picker");
    const svEl = document.getElementById("theme-color-sv");
    const svCursor = document.getElementById("theme-color-sv-cursor");
    const hueEl = document.getElementById("theme-color-hue");
    const hueCursor = document.getElementById("theme-color-hue-cursor");
    const eyedropperBtn = document.getElementById("theme-color-eyedropper");
    const swatches = document.querySelectorAll(".theme-color-swatch[data-theme-color-for]");
    if (!picker || !svEl || !hueEl || !themeInputText || !themeInputBg) return;

    const hsv = { h: 0, s: 0, v: 1 };
    let activeInput = null;
    let dragging = null;

    function clamp(n, min, max) {
      return Math.min(max, Math.max(min, n));
    }

    function hexToRgb(hex) {
      const n = themeApi()?.normalizeHexColor(hex);
      if (!n) return null;
      return {
        r: parseInt(n.slice(1, 3), 16),
        g: parseInt(n.slice(3, 5), 16),
        b: parseInt(n.slice(5, 7), 16),
      };
    }

    function rgbToHex(r, g, b) {
      const to = (c) => clamp(Math.round(c), 0, 255).toString(16).padStart(2, "0");
      return `#${to(r)}${to(g)}${to(b)}`;
    }

    function rgbToHsv(r, g, b) {
      r /= 255;
      g /= 255;
      b /= 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const d = max - min;
      let h = 0;
      if (d !== 0) {
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
      }
      return { h, s: max === 0 ? 0 : d / max, v: max };
    }

    function hsvToRgb(h, s, v) {
      const c = v * s;
      const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
      const m = v - c;
      let r = 0;
      let g = 0;
      let b = 0;
      if (h < 60) {
        r = c;
        g = x;
      } else if (h < 120) {
        r = x;
        g = c;
      } else if (h < 180) {
        g = c;
        b = x;
      } else if (h < 240) {
        g = x;
        b = c;
      } else if (h < 300) {
        r = x;
        b = c;
      } else {
        r = c;
        b = x;
      }
      return {
        r: (r + m) * 255,
        g: (g + m) * 255,
        b: (b + m) * 255,
      };
    }

    function hsvToHex(h, s, v) {
      const rgb = hsvToRgb(h, s, v);
      return rgbToHex(rgb.r, rgb.g, rgb.b);
    }

    function hueHex(h) {
      return hsvToHex(h, 1, 1);
    }

    function inputForSwatch(swatch) {
      return document.getElementById(swatch.dataset.themeColorFor || "");
    }

    function syncThemeColorSwatches() {
      swatches.forEach((swatch) => {
        const input = inputForSwatch(swatch);
        const hex = themeApi()?.normalizeHexColor(input?.value || "");
        swatch.style.background = hex || "transparent";
      });
    }

    function paintPicker() {
      picker.style.setProperty("--theme-picker-hue", hueHex(hsv.h));
      const svRect = svEl.getBoundingClientRect();
      const hueRect = hueEl.getBoundingClientRect();
      if (svCursor && svRect.width && svRect.height) {
        svCursor.style.left = `${hsv.s * 100}%`;
        svCursor.style.top = `${(1 - hsv.v) * 100}%`;
        svCursor.style.background = hsvToHex(hsv.h, hsv.s, hsv.v);
      }
      if (hueCursor && hueRect.width) {
        hueCursor.style.left = `${(hsv.h / 360) * 100}%`;
      }
    }

    function applyHsvToInput() {
      if (!activeInput) return;
      activeInput.value = hsvToHex(hsv.h, hsv.s, hsv.v);
      activeInput.dispatchEvent(new Event("input", { bubbles: true }));
      paintPicker();
    }

    function loadFromInput(input) {
      const rgb = hexToRgb(input?.value || "") || { r: 255, g: 255, b: 255 };
      const next = rgbToHsv(rgb.r, rgb.g, rgb.b);
      hsv.h = next.h;
      hsv.s = next.s;
      hsv.v = next.v;
      paintPicker();
    }

    function positionPicker(anchor) {
      const margin = 8;
      const rect = anchor.getBoundingClientRect();
      picker.hidden = false;
      const pop = picker.getBoundingClientRect();
      let top = rect.bottom + 6;
      let left = rect.left;
      if (top + pop.height > window.innerHeight - margin) {
        top = Math.max(margin, rect.top - pop.height - 6);
      }
      if (left + pop.width > window.innerWidth - margin) {
        left = Math.max(margin, window.innerWidth - pop.width - margin);
      }
      picker.style.top = `${top}px`;
      picker.style.left = `${left}px`;
    }

    function closePicker() {
      if (picker.hidden) return;
      picker.hidden = true;
      swatches.forEach((s) => s.setAttribute("aria-expanded", "false"));
      activeInput = null;
      dragging = null;
    }

    function openPicker(swatch) {
      const input = inputForSwatch(swatch);
      if (!input) return;
      if (activeInput === input && !picker.hidden) {
        closePicker();
        return;
      }
      activeInput = input;
      swatches.forEach((s) =>
        s.setAttribute("aria-expanded", String(s === swatch))
      );
      loadFromInput(input);
      positionPicker(swatch);
    }

    function svFromPointer(e) {
      const rect = svEl.getBoundingClientRect();
      hsv.s = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      hsv.v = clamp(1 - (e.clientY - rect.top) / rect.height, 0, 1);
      applyHsvToInput();
    }

    function hueFromPointer(e) {
      const rect = hueEl.getBoundingClientRect();
      hsv.h = clamp(((e.clientX - rect.left) / rect.width) * 360, 0, 359.99);
      applyHsvToInput();
    }

    svEl.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      svEl.setPointerCapture(e.pointerId);
      dragging = "sv";
      svFromPointer(e);
    });
    hueEl.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      hueEl.setPointerCapture(e.pointerId);
      dragging = "hue";
      hueFromPointer(e);
    });
    const onPointerMove = (e) => {
      if (dragging === "sv") svFromPointer(e);
      else if (dragging === "hue") hueFromPointer(e);
    };
    const onPointerUp = () => {
      dragging = null;
    };
    svEl.addEventListener("pointermove", onPointerMove);
    hueEl.addEventListener("pointermove", onPointerMove);
    svEl.addEventListener("pointerup", onPointerUp);
    hueEl.addEventListener("pointerup", onPointerUp);
    svEl.addEventListener("pointercancel", onPointerUp);
    hueEl.addEventListener("pointercancel", onPointerUp);

    swatches.forEach((swatch) => {
      swatch.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openPicker(swatch);
      });
    });

    themeInputText.addEventListener("input", () => {
      syncThemeColorSwatches();
      if (activeInput === themeInputText && !picker.hidden && !dragging) {
        loadFromInput(themeInputText);
      }
    });
    themeInputBg.addEventListener("input", () => {
      syncThemeColorSwatches();
      if (activeInput === themeInputBg && !picker.hidden && !dragging) {
        loadFromInput(themeInputBg);
      }
    });

    if (eyedropperBtn) {
      if (!window.EyeDropper) {
        eyedropperBtn.hidden = true;
      } else {
        eyedropperBtn.addEventListener("click", async (e) => {
          e.preventDefault();
          e.stopPropagation();
          try {
            const result = await new window.EyeDropper().open();
            const hex = themeApi()?.normalizeHexColor(result?.sRGBHex || "");
            if (!hex || !activeInput) return;
            activeInput.value = hex;
            activeInput.dispatchEvent(new Event("input", { bubbles: true }));
            loadFromInput(activeInput);
          } catch (_) {
            /* user cancelled */
          }
        });
      }
    }

    document.addEventListener("mousedown", (e) => {
      if (picker.hidden) return;
      if (picker.contains(e.target)) return;
      if (e.target.closest?.(".theme-color-swatch")) return;
      closePicker();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closePicker();
    });
    window.addEventListener("resize", closePicker);

    const originalFill = fillThemeFormFromTheme;
    fillThemeFormFromTheme = function (theme) {
      originalFill(theme);
      syncThemeColorSwatches();
      if (!picker.hidden && activeInput) loadFromInput(activeInput);
    };
    const originalSync = syncThemeInputs;
    syncThemeInputs = function () {
      originalSync();
      syncThemeColorSwatches();
      if (!picker.hidden && activeInput) loadFromInput(activeInput);
    };

    const sidebarEl = document.getElementById("sidebar");
    const fieldsObserver = new MutationObserver(() => {
      if (themeCustomFields?.hidden || sidebarEl?.hidden) closePicker();
    });
    if (themeCustomFields) {
      fieldsObserver.observe(themeCustomFields, {
        attributes: true,
        attributeFilter: ["hidden"],
      });
    }
    if (sidebarEl) {
      fieldsObserver.observe(sidebarEl, {
        attributes: true,
        attributeFilter: ["hidden"],
      });
    }

    syncThemeColorSwatches();
  })();

  if (themeApplyBtn) {
    themeApplyBtn.addEventListener("click", () => {
      const tw = themeApi();
      if (!tw || !themeInputText || !themeInputBg) return;
      const nt = tw.normalizeHexColor(themeInputText.value);
      const nb = tw.normalizeHexColor(themeInputBg.value);
      if (!nt || !nb) {
        setAuthMessage("Please enter colors in #RGB or #RRGGBB format.", true);
        return;
      }
      const name = (themeCustomName ? themeCustomName.value.trim() : "") || "";
      const fontId = themeFontSelect ? themeFontSelect.value : "";
      const id = editingCustomThemeId || tw.generateThemeId();
      const existing = tw.findCustomTheme(id);
      const saved = { id, name, text: nt, bg: nb, fontId };
      const themes = tw
        .getCustomThemes()
        .filter((t) => t.id !== id)
        .concat(saved);
      tw.saveCustomThemes(themes);
      const selectKey = tw.customThemeSelectKey(id);
      tw.applyThemeKey(selectKey);
      try {
        localStorage.setItem(tw.THEME_CUSTOM_FONT_KEY, fontId);
      } catch (_) {}
      setSelectedThemeKey(selectKey);
      editingCustomThemeId = null;
      buildThemeOptions();
      themeSelect.value = selectKey;
      if (themeCustomFields) themeCustomFields.hidden = true;
      updateThemeDeleteVisibility(selectKey);
      setAuthMessage(
        existing ? "Custom theme updated." : "Custom theme saved.",
        false
      );
    });
  }

  if (themeDeleteBtn) {
    themeDeleteBtn.addEventListener("click", () => {
      const tw = themeApi();
      if (!tw || !themeSelect) return;
      const key = themeSelect.value;
      if (!tw.isCustomThemeKey(key)) return;
      const id = tw.customThemeIdFromKey(key);
      tw.saveCustomThemes(tw.getCustomThemes().filter((t) => t.id !== id));
      editingCustomThemeId = null;
      applyThemeByKey(DEFAULT_THEME_KEY);
      syncThemeSelect();
      setAuthMessage("Custom theme deleted.", false);
    });
  }

  buildThemeFontOptions();
  syncThemeSelect();

  // Theme settings synced from another device: refresh the picker unless the
  // user is mid-edit in "Own..." (theme-init leaves that draft untouched).
  window.addEventListener(themeApi()?.THEME_REMOTE_CHANGE || "oneweek-theme-remote-change", () => {
    if (getSelectedThemeKey() === "own") {
      buildThemeOptions();
      themeSelect.value = "own";
      return;
    }
    syncThemeSelect();
  });
});

/**
 * Mobile-only: portal .task-row-actions to document.body and place it with
 * position:absolute in *document* coordinates (rect + scroll offset). Unlike
 * position:fixed, it scrolls with the task automatically — no scroll listener.
 */
(function setupMobileActionPanelPositioner() {
  const MOBILE_MEDIA = window.matchMedia
    ? window.matchMedia("(max-width: 900px)")
    : null;

  const ACTIVE_ROW_SELECTOR = [
    ".task-row:has(.task-text:focus)",
    ".task-row:has(.task-commit:focus)",
    ".task-row:has(.task-delete:focus)",
    ".task-row:has(.task-color:focus)",
    ".task-row:has(.task-star:focus)",
    ".task-row:has(.task-indent:focus)",
    ".task-row:has(.task-drag-handle:focus)",
    ".task-row.task-row-reorder-active",
    ".task-row.task-row-color-open",
  ].join(", ");

  const portaledPanelByRow = new WeakMap();
  const rowByPortaledPanel = new WeakMap();
  let observedRow = null;
  const rowResizeObserver = new ResizeObserver(() => scheduleUpdate());

  function isMobile() {
    return MOBILE_MEDIA ? MOBILE_MEDIA.matches : false;
  }

  function clearPanelStyles(panel) {
    panel.style.top = "";
    panel.style.left = "";
    panel.style.width = "";
    panel.style.right = "";
    panel.style.bottom = "";
  }

  function unportalPanel(panel) {
    if (!panel) return;
    panel.classList.remove("is-mobile-portaled");
    clearPanelStyles(panel);
    const row = rowByPortaledPanel.get(panel);
    rowByPortaledPanel.delete(panel);
    if (row) portaledPanelByRow.delete(row);
    if (panel.parentNode === document.body) {
      if (row?.isConnected) row.appendChild(panel);
      else panel.remove();
    }
  }

  function unportalAllPanels() {
    document.body.querySelectorAll(":scope > .task-row-actions").forEach(unportalPanel);
  }

  function getActionsPanel(row) {
    if (!row) return null;
    return portaledPanelByRow.get(row) || row.querySelector(":scope > .task-row-actions");
  }

  function portalPanel(panel, row) {
    portaledPanelByRow.set(row, panel);
    rowByPortaledPanel.set(panel, row);
    panel.classList.add("is-mobile-portaled");
    if (panel.parentNode !== document.body) document.body.appendChild(panel);
  }

  function positionPanel(panel, row) {
    const scrollX = window.scrollX || 0;
    const scrollY = window.scrollY || 0;
    const rect = row.getBoundingClientRect();
    panel.style.left = `${rect.left + scrollX}px`;
    panel.style.width = `${rect.width}px`;
    panel.style.right = "auto";
    if (row.classList.contains("completed")) {
      const panelHeight = panel.offsetHeight;
      panel.style.top = `${rect.top + scrollY - panelHeight - 6}px`;
    } else {
      panel.style.top = `${rect.bottom + scrollY + 6}px`;
    }
    panel.style.bottom = "auto";
  }

  function update() {
    if (!isMobile()) {
      unportalAllPanels();
      rowResizeObserver.disconnect();
      observedRow = null;
      return;
    }

    const row = document.querySelector(ACTIVE_ROW_SELECTOR);

    document.body.querySelectorAll(":scope > .task-row-actions").forEach((panel) => {
      const ownerRow = rowByPortaledPanel.get(panel);
      if (!ownerRow?.isConnected || ownerRow !== row) unportalPanel(panel);
    });

    if (!row) {
      rowResizeObserver.disconnect();
      observedRow = null;
      return;
    }

    if (observedRow !== row) {
      rowResizeObserver.disconnect();
      rowResizeObserver.observe(row);
      observedRow = row;
    }

    const panel = getActionsPanel(row);
    if (!panel) return;

    portalPanel(panel, row);
    positionPanel(panel, row);
  }

  let rafId = null;
  function scheduleUpdate() {
    if (rafId != null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      update();
    });
  }

  document.addEventListener("focusin", scheduleUpdate);
  document.addEventListener("focusout", () => setTimeout(scheduleUpdate, 0));
  document.addEventListener("input", (e) => {
    if (e.target?.classList?.contains("task-text")) scheduleUpdate();
  });
  window.addEventListener("resize", scheduleUpdate);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", scheduleUpdate);
  }
  if (MOBILE_MEDIA?.addEventListener) {
    MOBILE_MEDIA.addEventListener("change", scheduleUpdate);
  }

  const classObserver = new MutationObserver(scheduleUpdate);
  classObserver.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ["class"],
  });

  scheduleUpdate();
})();

/**
 * Guest auth modal — full-screen blurred overlay shown when the user has no
 * Supabase session. Separate Sign in and Create account actions; wrong
 * password never triggers an automatic sign-up attempt.
 */
(function setupGuestAuthModal() {
  const backdrop = document.getElementById("guest-auth-backdrop");
  const form = document.getElementById("guest-auth-form");
  const emailInput = document.getElementById("guest-auth-email");
  const passwordInput = document.getElementById("guest-auth-password");
  const signInBtn = document.getElementById("guest-auth-signin");
  const signUpBtn = document.getElementById("guest-auth-signup");
  const messageEl = document.getElementById("guest-auth-message");
  const messageSlot = document.getElementById("guest-auth-message-slot");
  const appMain = document.getElementById("app-main");
  if (!backdrop || !form || !emailInput || !passwordInput || !signInBtn || !signUpBtn) {
    return;
  }

  const supabase = window.supabaseClient;
  if (!supabase) return;

  function setMessage(text, isError = false) {
    if (!messageEl) return;
    messageEl.textContent = text || "";
    messageEl.classList.toggle("is-error", !!isError && !!text);
    if (messageSlot) messageSlot.classList.toggle("is-shown", !!text);
  }

  function setPending(isPending) {
    signInBtn.disabled = isPending;
    signUpBtn.disabled = isPending;
    emailInput.disabled = isPending;
    passwordInput.disabled = isPending;
    signInBtn.textContent = isPending ? "..." : "Sign in";
    signUpBtn.textContent = isPending ? "..." : "Create account";
  }

  function getGuestFocusables() {
    return [emailInput, passwordInput, signInBtn, signUpBtn].filter(
      (el) => el && !el.disabled
    );
  }

  /** Block task editing while guest auth is open; keep header menu reachable. */
  function setGuestBlockingInert(inert) {
    const tasksField = document.getElementById("tasks-field");
    const weekPanel = document.querySelector(".week-panel");
    const weekNav = document.querySelector(".layout-header-week");
    const headerRight = document.querySelector(".layout-header-right");
    if (tasksField) tasksField.inert = !!inert;
    if (weekPanel) weekPanel.inert = !!inert;
    if (weekNav) weekNav.inert = !!inert;
    if (headerRight) headerRight.inert = !!inert;
    if (appMain) appMain.removeAttribute("inert");
  }

  function trapGuestFocus(e) {
    if (backdrop.hidden) return;
    if (e.key !== "Tab") return;
    const focusables = getGuestFocusables();
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    } else if (!backdrop.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    }
  }

  function onGuestKeydown(e) {
    if (backdrop.hidden) return;
    // Blocking auth: Escape must not dismiss. Still swallow so it doesn't
    // hit other UI behind the inert main.
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function show() {
    if (!backdrop.hidden) return;
    backdrop.hidden = false;
    setGuestBlockingInert(true);
    requestAnimationFrame(() => emailInput.focus({ preventScroll: true }));
  }

  window.oneweekOpenGuestAuth = () => {
    if (!backdrop.hidden) {
      requestAnimationFrame(() => emailInput.focus({ preventScroll: true }));
      return;
    }
    show();
  };

  function hide() {
    if (backdrop.hidden) return;
    backdrop.hidden = true;
    setGuestBlockingInert(false);
    setMessage("");
    setPending(false);
    form.reset();
  }

  function looksLikeUnconfirmedEmail(error) {
    const msg = String(error?.message || error || "").toLowerCase();
    return msg.includes("email not confirmed") || msg.includes("not confirmed");
  }

  function showConfirmEmailMessage(email) {
    const target = email ? ` to ${email}` : "";
    setMessage(
      `We sent a confirmation link${target}. Open it to finish signing in.`
    );
  }

  function readCredentials() {
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !password) {
      setMessage("Enter your email and password.", true);
      return null;
    }
    return { email, password };
  }

  async function handleSignIn(e) {
    e.preventDefault();
    const creds = readCredentials();
    if (!creds) return;

    setPending(true);
    setMessage("Signing in...");

    const { error: signInError } = await supabase.auth.signInWithPassword(creds);

    if (!signInError) {
      setMessage("");
      setPending(false);
      return;
    }

    if (looksLikeUnconfirmedEmail(signInError)) {
      try {
        await supabase.auth.resend({
          type: "signup",
          email: creds.email,
          options: { emailRedirectTo: getAuthEmailRedirectTo() },
        });
      } catch (_) {
        /* best-effort */
      }
      setPending(false);
      showConfirmEmailMessage(creds.email);
      return;
    }

    setPending(false);
    setMessage(signInError.message || "Wrong email or password.", true);
  }

  async function handleSignUp() {
    const creds = readCredentials();
    if (!creds) return;

    setPending(true);
    setMessage("Creating account...");

    const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
      email: creds.email,
      password: creds.password,
      options: { emailRedirectTo: getAuthEmailRedirectTo() },
    });

    setPending(false);

    if (signUpError) {
      setMessage(signUpError.message || "Couldn't create account.", true);
      return;
    }

    if (signUpData?.session) {
      setMessage("");
      return;
    }
    showConfirmEmailMessage(creds.email);
  }

  form.addEventListener("submit", handleSignIn);
  signUpBtn.addEventListener("click", () => {
    void handleSignUp();
  });
  backdrop.addEventListener("keydown", trapGuestFocus);
  document.addEventListener("keydown", onGuestKeydown, true);

  async function applySession(session) {
    if (session?.user) {
      hide();
      return;
    }
    show();
    const callbackError = window.__oneweekAuthCallbackError;
    if (callbackError) {
      setMessage(callbackError, true);
    }
  }

  window.oneweekAuth.subscribe((session) => {
    void applySession(session);
  });
})();
