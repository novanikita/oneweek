/**
 * One Week — shared helpers and task utilities used by the general panel,
 * week/day panels, week navigation, and auth UI.
 */

/** Local midnight Monday of the week containing `anchorDate`; `weekOffsetWeeks` shifts by whole weeks. */
function getWeekMondayStart(anchorDate, weekOffsetWeeks = 0) {
  const d = new Date(anchorDate);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay();
  const mondayOffset = (dow + 6) % 7;
  d.setDate(d.getDate() - mondayOffset + weekOffsetWeeks * 7);
  return d;
}

/** Monday 00:00 of the week currently shown (week arrows / __weekOffset). */
function getVisibleWeekStartDate() {
  return getWeekMondayStart(new Date(), Number(window.__weekOffset || 0));
}

function toIsoDateFromDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getVisibleWeekMondayIso() {
  return toIsoDateFromDate(getVisibleWeekStartDate());
}

/** Calendar “this week” Monday — for one-time migration of legacy rows without `date`. */
function getCalendarWeekMondayIso() {
  return toIsoDateFromDate(getWeekMondayStart(new Date(), 0));
}

function isTaskEmptyText(text) {
  return (text ?? "").trim() === "";
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
 * Undo stack (Ctrl/Cmd+Z). Each panel (general, daily-per-day) registers a
 * restore handler keyed by its block id; deletion handlers push an entry onto
 * the shared stack, and the global keydown listener pops + dispatches to the
 * right block. Only the action of "task deleted via trash button" is currently
 * undoable — text edits are handled by the browser's native textarea undo.
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

function updateConnectionBanner() {
  const banner = document.getElementById("connection-banner");
  if (!banner) return;
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

function createPersistTask(insertOrUpdateTaskInDb, logPrefix = "Supabase persist failed:", onSettled = null) {
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

  el.style.height = "0";
  syncTaskRowMultiline(el);

  // For single-line rows we always pin the height to the exact computed
  // line-height + paddings. Using scrollHeight here causes ±1px jitter
  // between empty and filled rows because browsers round scrollHeight to a
  // whole pixel while the CSS line-height is fractional (e.g. 19.2 vs 20).
  const oneLineHeight = getTaskInputOneLineHeight(el);
  const isMultiline = row?.classList.contains("task-row-multiline");
  let safeHeight = isMultiline
    ? Math.max(el.scrollHeight, oneLineHeight)
    : oneLineHeight;
  el.style.height = `${safeHeight}px`;

  // Re-measure once if the multiline flag toggled — applying the new height
  // can change scrollHeight (e.g. wider single-line content reflows narrower).
  if (wasMultiline !== isMultiline) {
    el.style.height = "0";
    safeHeight = isMultiline
      ? Math.max(el.scrollHeight, oneLineHeight)
      : oneLineHeight;
    el.style.height = `${safeHeight}px`;
  }
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
    return window.oneweekWorkspaces?.getActiveId?.() || null;
  } catch {
    return null;
  }
}

async function awaitWorkspaceReady(userId) {
  const ws = window.oneweekWorkspaces;
  if (!ws) return;
  if (typeof ws.ensureReadyFor === "function") {
    try {
      await ws.ensureReadyFor(userId);
    } catch {
      /* already logged */
    }
    return;
  }
  if (typeof ws.ensureReady === "function") {
    try {
      await ws.ensureReady();
    } catch {
      /* already logged */
    }
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

function syncPositionsFromArray(tasks) {
  for (let i = 0; i < tasks.length; i++) {
    tasks[i].position = i;
  }
}

function taskIndexInList(tasks, task) {
  if (!task?.id || !tasks) return -1;
  return tasks.findIndex((t) => t.id === task.id);
}

/** Push 0..n-1 positions for persisted rows (after drag, toggle, paste, etc.). */
async function persistTaskPositions(supabase, userId, tasks) {
  if (!supabase || !userId || !tasks?.length) return;
  syncPositionsFromArray(tasks);
  const updates = tasks
    .map((t, position) => ({ dbId: t.dbId, position }))
    .filter((u) => u.dbId != null);
  if (updates.length === 0) return;

  const results = await Promise.all(
    updates.map(({ dbId, position }) =>
      supabase
        .from("tasks")
        .update({ position })
        .eq("id", dbId)
        .eq("user_id", userId)
    )
  );
  const error = results.find((r) => r.error)?.error;
  if (error) {
    markNetworkFailure(error);
    throw error;
  }
  markNetworkSuccess();
}

function createPositionPersistScheduler(supabase, getUserId, getTasks) {
  let chain = Promise.resolve();
  return function schedulePersistTaskPositions() {
    const userId = getUserId();
    const tasks = getTasks();
    if (!supabase || !userId || !tasks?.length) return;
    chain = chain
      .then(() => persistTaskPositions(supabase, userId, tasks))
      .catch((err) => {
        console.error("Supabase position persist failed:", err);
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

if (typeof window !== "undefined") {
  window.__flushAllTaskSaves = flushAllTaskSaves;
}

/** Full cross-panel payload on dataTransfer (global store can be cleared in dragend before drop in some browsers). */
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

/** Palette of pastel highlight colors for tasks. `null` = no color. */
const TASK_COLOR_PALETTE = [
  "#ebebeb",
  "#f0e2d3",
  "#fbe6cd",
  "#f8efbf",
  "#e2ece0",
  "#dde8f1",
  "#e7dfee",
  "#f3d8e1",
  "#f8dada",
];

function isValidTaskColor(color) {
  if (color == null || color === "") return true;
  return TASK_COLOR_PALETTE.includes(String(color).toLowerCase());
}

function normalizeTaskColor(color) {
  if (color == null || color === "") return null;
  const c = String(color).toLowerCase();
  return TASK_COLOR_PALETTE.includes(c) ? c : null;
}

/** Apply / clear the highlight color on a task row element. */
function applyTaskRowColor(row, color) {
  if (!row) return;
  const c = normalizeTaskColor(color);
  if (c) {
    row.style.background = c;
    row.dataset.color = c;
  } else {
    row.style.background = "";
    delete row.dataset.color;
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

function syncTaskColorButton(btn, color) {
  if (!btn) return;
  const dot = btn.querySelector(".task-color-dot");
  if (!dot) return;
  const c = normalizeTaskColor(color);
  if (c) {
    dot.style.background = c;
    dot.dataset.filled = "1";
  } else {
    dot.style.background = "";
    delete dot.dataset.filled;
  }
}

let activeColorPicker = null;

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

function openTaskColorPicker(anchor, currentColor, onSelect, restoreFocusInput, rowEl) {
  closeTaskColorPicker(false);
  if (!anchor) return;

  const pop = document.createElement("div");
  pop.className = "task-color-popover";

  const grid = document.createElement("div");
  grid.className = "task-color-grid";

  const current = normalizeTaskColor(currentColor);

  const noneBtn = document.createElement("button");
  noneBtn.type = "button";
  noneBtn.className = "task-color-swatch task-color-swatch-none";
  noneBtn.setAttribute("aria-label", "No color");
  if (!current) noneBtn.classList.add("task-color-swatch-active");
  noneBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onSelect(null);
    closeTaskColorPicker(true);
  });
  grid.appendChild(noneBtn);

  for (const color of TASK_COLOR_PALETTE) {
    const s = document.createElement("button");
    s.type = "button";
    s.className = "task-color-swatch";
    s.style.background = color;
    s.setAttribute("aria-label", `Color ${color}`);
    if (current === color) s.classList.add("task-color-swatch-active");
    s.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onSelect(color);
      closeTaskColorPicker(true);
    });
    grid.appendChild(s);
  }

  pop.appendChild(grid);
  document.body.appendChild(pop);

  function position() {
    const rect = anchor.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    const margin = 8;
    let top = rect.bottom + 6;
    // Center horizontally under the row (so the picker lines up with the
    // actions popover, which is itself centered under the row). Fall back to
    // centering under the anchor button if the row isn't known.
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
    if (e.key === "Escape") closeTaskColorPicker(true);
  };
  const onScroll = () => position();

  document.addEventListener("mousedown", onOutside, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onScroll, true);

  activeColorPicker = { el: pop, onOutside, onKey, onScroll, restoreFocusInput, rowEl };

  if (restoreFocusInput?.isConnected) {
    restoreFocusInput.focus({ preventScroll: true });
  }
}

function wireTaskDragHandle(dragHandle, row, isAuthed, onDragStart, onDragEnd) {
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
        if (!row.classList.contains("task-row-dragging")) {
          endDragInteraction();
        }
      });
    };
    window.addEventListener("mouseup", onPointerUp);
    window.addEventListener("pointerup", onPointerUp);
  };

  const onHandlePointerDown = (e) => {
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
}

function taskRowInsertBefore(e, row) {
  const rect = row.getBoundingClientRect();
  return e.clientY < rect.top + rect.height / 2;
}

function computeReorderInsertIndex(fromIndex, targetIndex, insertBefore) {
  let insertAt = insertBefore ? targetIndex : targetIndex + 1;
  if (fromIndex >= 0 && fromIndex < insertAt) insertAt--;
  return insertAt;
}

function reorderTaskInArray(tasks, fromIndex, targetIndex, insertBefore) {
  if (fromIndex < 0 || targetIndex < 0) return null;
  const insertAt = computeReorderInsertIndex(fromIndex, targetIndex, insertBefore);
  if (insertAt === fromIndex) return null;
  const [moved] = tasks.splice(fromIndex, 1);
  tasks.splice(insertAt, 0, moved);
  return moved;
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
      indicator.hidden = true;
    },
  };
}

function hideAllTaskDropIndicators() {
  document.querySelectorAll(".task-drop-indicator").forEach((el) => {
    el.hidden = true;
  });
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
function showCrossDropIndicator(indicator, listEl, insertAt) {
  if (!listEl) {
    indicator.hide();
    return;
  }
  const rows = listEl.querySelectorAll(".task-row:not(.task-row-dragging)");
  if (insertAt >= rows.length) {
    indicator.showAtEnd(listEl);
    return;
  }
  indicator.showBeforeRow(rows[Math.max(0, insertAt)]);
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
  const { error } = await supabase
    .from("tasks")
    .update(update)
    .eq("id", rowId)
    .eq("user_id", userId);
  if (error) return { ok: false, error };
  return { ok: true, error: null };
}

function normalizeSubtaskFlags(tasks) {
  for (let i = 0; i < tasks.length; i++) {
    if (!tasks[i].subtask) continue;
    let ok = false;
    for (let j = 0; j < i; j++) {
      if (!tasks[j].subtask) {
        ok = true;
        break;
      }
    }
    if (!ok) tasks[i].subtask = false;
  }
}

function canIndentAsSubtask(tasks, idx) {
  if (idx <= 0) return false;
  normalizeSubtaskFlags(tasks);
  return true;
}

function isTabNavigationKey(e) {
  return e.key === "Tab" || e.code === "Tab" || e.keyCode === 9;
}

/** First index after the run of subtasks that follow `mainIdx` (end of that subtree in flat list). */
function indexAfterSubtreeOfMain(tasks, mainIdx) {
  let pos = mainIdx + 1;
  while (pos < tasks.length && tasks[pos].subtask) pos++;
  return pos;
}

/**
 * Where to place `fromIdx` so it becomes a sub-item of the row directly above it
 * (`fromIdx - 1`): under that main’s subtree, or after that subtask’s sibling run.
 */
function insertIndexUnderImmediateRowAbove(tasks, fromIdx) {
  if (fromIdx <= 0) return fromIdx;
  const aboveIdx = fromIdx - 1;
  if (!tasks[aboveIdx].subtask) {
    return indexAfterSubtreeOfMain(tasks, aboveIdx);
  }
  let k = aboveIdx + 1;
  while (k < tasks.length && tasks[k].subtask) k += 1;
  return k;
}

/** Moves row at `fromIdx` to the slot where it is nested under the line immediately above. */
function moveSubtaskUnderImmediateRowAbove(tasks, fromIdx) {
  if (fromIdx <= 0) return fromIdx;
  const insertAt = insertIndexUnderImmediateRowAbove(tasks, fromIdx);
  if (fromIdx === insertAt) return fromIdx;
  const [row] = tasks.splice(fromIdx, 1);
  const adjustedInsert = fromIdx < insertAt ? insertAt - 1 : insertAt;
  tasks.splice(adjustedInsert, 0, row);
  return adjustedInsert;
}

function firstCheckedTaskIndex(tasks) {
  return tasks.findIndex((t) => t.checked);
}

/**
 * Split a flat task array into groups of `{ main, subs }`, where `subs` is the
 * uninterrupted run of `subtask` rows that follow each non-subtask row. An
 * orphan subtask (no main above it) becomes its own group with empty subs.
 */
function splitIntoTaskGroups(tasks) {
  const groups = [];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (t.subtask && groups.length > 0 && !groups[groups.length - 1].main.subtask) {
      groups[groups.length - 1].subs.push(t);
    } else {
      groups.push({ main: t, subs: [] });
    }
  }
  return groups;
}

/**
 * Unchecked-first ordering that respects subtask groups:
 *   - Inside each group: main stays on top; subtasks split unchecked-before-checked.
 *   - Between groups: groups whose `main` is checked sink to the bottom in their
 *     original relative order.
 * This keeps a freshly-checked subtask glued to the bottom of its parent's
 * subtask pile instead of escaping to the global completed stack at the end of
 * the field.
 */
function partitionUncheckedBeforeChecked(tasks) {
  const groups = splitIntoTaskGroups(tasks);
  for (const g of groups) {
    const u = g.subs.filter((s) => !s.checked);
    const c = g.subs.filter((s) => s.checked);
    g.subs = [...u, ...c];
  }
  const uncheckedGroups = groups.filter((g) => !g.main.checked);
  const checkedGroups = groups.filter((g) => g.main.checked);
  const result = [];
  for (const g of [...uncheckedGroups, ...checkedGroups]) {
    result.push(g.main, ...g.subs);
  }
  return result;
}

/**
 * Index to splice a new unchecked task "below" `belowIdx` without placing it
 * after any completed task.
 */
function insertIndexBelowRowUncheckedFirst(tasks, belowIdx) {
  const fc = firstCheckedTaskIndex(tasks);
  let insertAt = belowIdx === -1 ? tasks.length : belowIdx + 1;
  if (belowIdx >= 0 && tasks[belowIdx].checked) {
    insertAt = fc === -1 ? insertAt : fc;
  } else if (fc !== -1 && insertAt > fc) {
    insertAt = fc;
  }
  return insertAt;
}

/**
 * Toggle task completion and reposition the row according to subtask grouping:
 *   - Main tasks fall to / float back from the global completed pile at the
 *     bottom (newly checked land at the TOP of that pile so it grows upward).
 *   - Subtasks stay inside their parent's subtask run: checking sinks them to
 *     the bottom of that run, unchecking pops them to the top.
 */
function toggleAndRepositionTask(tasks, idx) {
  const task = tasks[idx];
  task.checked = !task.checked;
  const reordered = partitionUncheckedBeforeChecked(tasks);
  tasks.length = 0;
  for (const t of reordered) tasks.push(t);
  return task;
}

(() => {
  const tasksField = document.getElementById("tasks-field");
  const tasksFieldRoot = document.getElementById("tasks-field-root");
  if (!tasksField || !tasksFieldRoot) return;
  const GENERAL_BLOCK_ID = "general";

  const state = {
    tasks: [],
    nextId: 1,
    draggedId: null,
    isDragging: false,
    focusAfterRender: null, // { id, start, end }
  };

  const supabase = window.supabaseClient;
  let authUserId = null;
  let isAuthed = false;
  /** Bumps on each load; stale in-flight responses are ignored. */
  let generalLoadGen = 0;
  /** Workspace id last applied from server/cache; guards render() cache writes. */
  let tasksWorkspaceId = null;
  /** Empty-area click right after editing: save only, do not open a new draft row. */
  let suppressGeneralEmptyClickNewTask = false;
  const generalDropIndicator = createTaskDropIndicator(tasksField, tasksFieldRoot);

  function createTask(text = "", checked = false, dbId = null, subtask = false, color = null) {
    const id = `task-${state.nextId++}`;
    return {
      id,
      dbId,
      text,
      checked,
      subtask: !!subtask,
      color: normalizeTaskColor(color),
      _dirty: false,
    };
  }

  function buildDragPayload(task) {
    return {
      sourceBlock: GENERAL_BLOCK_ID,
      localId: task.id,
      dbId: task.dbId ?? null,
      text: task.text ?? "",
      checked: !!task.checked,
      subtask: !!task.subtask,
      color: normalizeTaskColor(task.color),
    };
  }

  function setGlobalDragPayload(payload) {
    window.__dragTaskPayload = payload;
  }

  function getGlobalDragPayload() {
    return window.__dragTaskPayload || null;
  }

  function clearGlobalDragPayload() {
    window.__dragTaskPayload = null;
  }

  function getTaskIndex(id) {
    return state.tasks.findIndex((t) => t.id === id);
  }

  function setTasksInteractivity(enabled) {
    tasksField.classList.toggle("tasks-field--guest", !enabled);
    document.querySelectorAll(".day-rect").forEach((el) => {
      el.style.pointerEvents = enabled ? "auto" : "none";
    });
    document
      .querySelectorAll("#tasks-field-root .task-text, .day-tasks .task-text")
      .forEach((el) => {
        el.readOnly = !enabled;
      });

    document.querySelectorAll(".task-checkbox").forEach((btn) => {
      btn.tabIndex = enabled ? 0 : -1;
    });
  }

  // Default to locked state until Supabase session is resolved.
  setTasksInteractivity(false);

  async function deleteTaskFromDb(task) {
    if (!isAuthed || !authUserId) return;
    if (!task?.dbId) return;

    const { error } = await supabase
      .from("tasks")
      .delete()
      .eq("id", task.dbId)
      .eq("user_id", authUserId);

    if (error) {
      markNetworkFailure(error);
      console.error("Supabase delete failed:", error);
      throw error;
    }
    markNetworkSuccess();
    task.dbId = null;
  }

  async function insertOrUpdateTaskInDb(task, snapshot) {
    if (!isAuthed || !authUserId) return;
    if (!task) return;

    const source = snapshot || task;
    const content = String(source.text ?? "");
    const completed = !!source.checked;
    const isSubtask = !!source.subtask;
    const color = normalizeTaskColor(source.color);
    const dbId = source.dbId ?? task.dbId ?? null;

    // Never auto-delete on empty text: blur/flush must not lose persisted rows.
    // The empty draft (no dbId yet) is also a no-op here — nothing to insert.
    if (isTaskEmptyText(content) && !dbId) {
      return;
    }

    const idx = taskIndexInList(state.tasks, task);
    const position = idx >= 0 ? idx : state.tasks.length;

    // If it exists already, update it. Otherwise insert a new row.
    if (dbId) {
      // Only content flags here. Do not set type/date/day_name on update — a stale
      // persist from this panel after a drag to a day would otherwise overwrite the row
      // back to "general". Cross-block moves use explicit updates; inserts set type/date.
      const { error } = await supabase
        .from("tasks")
        .update({
          content,
          completed,
          is_subtask: isSubtask,
          color,
          position,
        })
        .eq("id", dbId)
        .eq("user_id", authUserId);

      if (error) {
        markNetworkFailure(error);
        console.error("Supabase update failed:", error);
        throw error;
      }
      markNetworkSuccess();
      return;
    }

    const workspaceId = getActiveWorkspaceId();
    const insertPayload = {
      user_id: authUserId,
      content,
      completed,
      type: "general",
      date: getVisibleWeekMondayIso(),
      is_subtask: isSubtask,
      color,
      position,
    };
    if (workspaceId) insertPayload.workspace_id = workspaceId;

    const { data, error } = await supabase
      .from("tasks")
      .insert(insertPayload)
      .select("id")
      .single();

    if (error) {
      markNetworkFailure(error);
      console.error("Supabase insert failed:", error);
      throw error;
    }

    markNetworkSuccess();
    task.dbId = data?.id ?? null;
    task.position = position;
  }

  const persistTask = createPersistTask(
    insertOrUpdateTaskInDb,
    "Supabase persist failed:",
    () => {
      if (!authUserId) return;
      const wsId = getActiveWorkspaceId();
      if (!wsId || tasksWorkspaceId !== wsId) return;
      writeTasksCache(
        generalTasksCacheKey(authUserId, getVisibleWeekMondayIso(), wsId),
        state.tasks
      );
    }
  );

  const schedulePersistTaskPositions = createPositionPersistScheduler(
    supabase,
    () => authUserId,
    () => state.tasks
  );

  function applyCachedGeneralTasks(weekIso) {
    if (!authUserId) return false;
    const workspaceId = getActiveWorkspaceId();
    const cached = readTasksCache(
      generalTasksCacheKey(authUserId, weekIso, workspaceId)
    );
    if (!cached) return false;
    state.tasks = cached.map((row, i) => ({
      id: `task-${state.nextId++}`,
      dbId: row.dbId ?? null,
      text: row.text ?? "",
      checked: !!row.checked,
      subtask: !!row.subtask,
      color: normalizeTaskColor(row.color),
      position: typeof row.position === "number" ? row.position : i,
      _dirty: !!row.dirty,
    }));
    normalizeSubtaskFlags(state.tasks);
    return true;
  }

  /**
   * Combine the authoritative server snapshot with anything the user changed
   * locally that hasn't been persisted yet, while preserving the user's
   * client-side ordering.
   *
   * Why client-side order is the source of truth: the `tasks` table has no
   * sort column, so the server can only return rows by `created_at`. Honouring
   * that order would erase any drag-and-drop reorder the user did, which is
   * exactly the "tasks swap places after reload / workspace switch" bug.
   *
   * Algorithm:
   *   1. Walk `localBefore` in its existing order.
   *      - If the row exists on the server, emit it at this position; use
   *        local content if the row is `_dirty`, otherwise use the fresh
   *        server snapshot.
   *      - Dirty drafts without a dbId (created locally while offline or
   *        mid-persist) are emitted in place. If a server row has matching
   *        content, the orphan is merged into that row instead of being
   *        duplicated — this fixes the "ghost duplicate after reload" bug
   *        where the create succeeded server-side but the cache still had
   *        `dbId=null` when the page reloaded.
   *   2. Append any server rows we haven't placed yet (e.g. added on another
   *      device) at the end so they aren't lost.
   */
  function mergeLocalEditsIntoServerSnapshot(serverTasks, localBefore) {
    const serverByDbId = new Map();
    for (const s of serverTasks) {
      if (s.dbId) serverByDbId.set(s.dbId, s);
    }

    const usedDbIds = new Set();
    const result = [];

    function contentKey(t) {
      return `${String(t.text ?? "").trim()}|${t.checked ? 1 : 0}|${t.subtask ? 1 : 0}`;
    }
    const unusedServerByContent = new Map();
    for (const srv of serverTasks) {
      if (!srv.dbId) continue;
      const k = contentKey(srv);
      if (!unusedServerByContent.has(k)) unusedServerByContent.set(k, []);
      unusedServerByContent.get(k).push(srv);
    }

    for (const local of localBefore) {
      if (local.dbId) {
        const srv = serverByDbId.get(local.dbId);
        if (!srv) {
          // Row vanished on the server (e.g. deleted from another device).
          if (local._dirty && !isTaskEmptyText(local.text)) {
            result.push({ ...local, dbId: null });
            const bucket = unusedServerByContent.get(contentKey(local));
            if (bucket && bucket.length) bucket.shift();
          }
          continue;
        }
        usedDbIds.add(local.dbId);
        const bucket = unusedServerByContent.get(contentKey(srv));
        if (bucket) {
          const idx = bucket.indexOf(srv);
          if (idx !== -1) bucket.splice(idx, 1);
        }
        if (local._dirty) {
          result.push({
            ...srv,
            id: local.id,
            text: local.text,
            checked: local.checked,
            subtask: local.subtask,
            color: normalizeTaskColor(local.color),
            _dirty: true,
          });
        } else {
          result.push({ ...srv, id: local.id });
        }
      } else if (!isTaskEmptyText(local.text)) {
        const k = contentKey(local);
        const bucket = unusedServerByContent.get(k);
        const match = bucket && bucket.length ? bucket.shift() : null;
        if (match) {
          usedDbIds.add(match.dbId);
          result.push({ ...match, id: local.id });
        } else if (local._dirty) {
          result.push({
            id: local.id,
            dbId: null,
            text: local.text,
            checked: !!local.checked,
            subtask: !!local.subtask,
            color: normalizeTaskColor(local.color),
            _dirty: true,
          });
        }
      }
    }

    for (const srv of serverTasks) {
      if (!srv.dbId || usedDbIds.has(srv.dbId)) continue;
      result.push(srv);
    }

    return result;
  }

  async function loadTasksForUser() {
    if (!supabase) {
      console.error("Supabase client is not initialized.");
      return;
    }
    if (!authUserId) return;

    const loadGen = ++generalLoadGen;
    const requestedWeekIso = getVisibleWeekMondayIso();
    tasksWorkspaceId = null;

    // Paint the cached state first so a flaky network can't hide the user's data.
    // If there's no cache for this week, clear the list so we never accidentally
    // show another week's tasks while the network request is in flight.
    const hadCache = applyCachedGeneralTasks(requestedWeekIso);
    if (!hadCache) state.tasks = [];
    render();

    const migrateKey = `oneweek-general-date-migrated-${authUserId}`;
    if (!localStorage.getItem(migrateKey)) {
      const anchorIso = getCalendarWeekMondayIso();
      const { error: migErr } = await supabase
        .from("tasks")
        .update({ date: anchorIso })
        .eq("user_id", authUserId)
        .eq("type", "general")
        .is("date", null);
      if (!migErr) localStorage.setItem(migrateKey, "1");
    }

    if (getVisibleWeekMondayIso() !== requestedWeekIso) return;
    if (loadGen !== generalLoadGen) return;

    const workspaceId = getActiveWorkspaceId();
    let query = supabase
      .from("tasks")
      .select("id, content, completed, created_at, is_subtask, color, position")
      .eq("user_id", authUserId)
      .eq("type", "general")
      .eq("date", requestedWeekIso);
    if (workspaceId) query = query.eq("workspace_id", workspaceId);
    const { data, error } = await query
      .order("position", { ascending: true })
      .order("created_at", { ascending: true });

    if (error) {
      // Keep whatever we already showed from cache — losing it would surprise the user.
      markNetworkFailure(error);
      console.error("Supabase load failed (keeping cached tasks):", error);
      return;
    }
    markNetworkSuccess();

    if (getVisibleWeekMondayIso() !== requestedWeekIso) return;
    if (getActiveWorkspaceId() !== workspaceId) return;
    if (loadGen !== generalLoadGen) return;

    const localBefore = state.tasks;
    const serverTasks = (data ?? []).map((row) => ({
      id: `task-${state.nextId++}`,
      dbId: row.id,
      text: row.content ?? "",
      checked: !!row.completed,
      subtask: !!row.is_subtask,
      color: normalizeTaskColor(row.color),
      position: row.position ?? 0,
      _dirty: false,
    }));
    state.tasks = mergeLocalEditsIntoServerSnapshot(serverTasks, localBefore);
    normalizeSubtaskFlags(state.tasks);
    syncPositionsFromArray(state.tasks);
    tasksWorkspaceId = workspaceId;
    writeTasksCache(
      generalTasksCacheKey(authUserId, requestedWeekIso, workspaceId),
      state.tasks
    );
    render();

    // Network is back: push any local edits that were waiting.
    for (const t of state.tasks) {
      if (t._dirty) void persistTask(t);
    }
  }

  async function handleSession(session) {
    const hasUser = !!session?.user;
    const nextUserId = session?.user?.id ?? null;

    setTasksInteractivity(hasUser);

    if (!hasUser) {
      if (!isAuthed && !authUserId) return;
      isAuthed = false;
      authUserId = null;
      tasksWorkspaceId = null;
      state.tasks = [];
      renderGuestPrompt();
      updateMoveRemainingBtn();
      return;
    }

    // Supabase fires INITIAL_SESSION right after getSession — skip duplicate load.
    if (isAuthed && authUserId === nextUserId) return;

    isAuthed = true;
    authUserId = nextUserId;

    await awaitWorkspaceReady(authUserId);
    await loadTasksForUser();
    updateMoveRemainingBtn();
  }

  async function initAuth() {
    if (!supabase) {
      console.error("Supabase client is not initialized.");
      return;
    }

    const { data } = await supabase.auth.getSession();
    await handleSession(data?.session);

    supabase.auth.onAuthStateChange((_event, session) => {
      void handleSession(session);
    });
  }

  function removeTaskRow(taskId) {
    const idx = getTaskIndex(taskId);
    if (idx === -1) return;
    const task = state.tasks[idx];

    // Remember enough to fully recreate the row on Ctrl/Cmd+Z, tied to the
    // exact week + workspace it lived in.
    oneweekPushUndo({
      blockId: GENERAL_BLOCK_ID,
      type: "delete",
      weekIso: getVisibleWeekMondayIso(),
      workspaceId: getActiveWorkspaceId(),
      userId: authUserId,
      position: idx,
      snapshot: {
        text: task.text,
        checked: !!task.checked,
        subtask: !!task.subtask,
        color: normalizeTaskColor(task.color),
      },
    });

    if (task.dbId) void deleteTaskFromDb(task);
    state.focusAfterRender = null;
    state.tasks.splice(idx, 1);
    schedulePersistTaskPositions();
    render();
  }

  oneweekRegisterUndoHandler(GENERAL_BLOCK_ID, async (entry) => {
    if (entry.type !== "delete") return false;
    // Only restore if the user is still signed in as the same user and looking
    // at the same week/workspace where the delete happened. Otherwise leave
    // the entry alone (the loop will try the next one or no-op).
    if (!authUserId || entry.userId !== authUserId) return false;
    if (entry.weekIso !== getVisibleWeekMondayIso()) return false;
    if ((entry.workspaceId || null) !== (getActiveWorkspaceId() || null)) {
      return false;
    }
    const s = entry.snapshot || {};
    const restored = createTask(
      s.text ?? "",
      !!s.checked,
      null,
      !!s.subtask,
      normalizeTaskColor(s.color)
    );
    const at = Math.max(0, Math.min(entry.position ?? state.tasks.length, state.tasks.length));
    state.tasks.splice(at, 0, restored);
    normalizeSubtaskFlags(state.tasks);
    state.focusAfterRender = { id: restored.id };
    if (!isTaskEmptyText(restored.text)) {
      markTaskDirty(restored);
      void persistTask(restored);
    }
    schedulePersistTaskPositions();
    render();
    return true;
  });

  async function syncTaskFromInput(taskId) {
    const idx = getTaskIndex(taskId);
    if (idx === -1) return { needRender: true };
    const row = tasksFieldRoot.querySelector(`.task-row[data-id="${taskId}"]`);
    const input = row?.querySelector(".task-text");
    if (!input) return { needRender: true };
    const currentText = input.value;
    const task = state.tasks[idx];
    task.text = currentText;
    normalizeSubtaskFlags(state.tasks);
    if (isTaskEmptyText(currentText)) {
      if (!task.dbId) {
        // Brand-new draft never persisted — safe to drop from local state.
        state.focusAfterRender = null;
        state.tasks.splice(idx, 1);
        return { needRender: true };
      }
      // Existing task became empty: persist the cleared text but keep the row.
      // Users delete via the explicit trash button; blur must never lose data.
      void persistTask(task);
      return { needRender: false };
    }
    // Do not await: UI would freeze for one network round-trip per blur/commit.
    void persistTask(task);
    return { needRender: false };
  }

  async function commitTask(taskId) {
    const { needRender } = await syncTaskFromInput(taskId);
    state.tasks = partitionUncheckedBeforeChecked(state.tasks);
    schedulePersistTaskPositions();
    render();
    return !needRender;
  }

  function focusTask(id, start, end) {
    const row = tasksFieldRoot.querySelector(`.task-row[data-id="${id}"]`);
    if (!row) return;
    const input = row.querySelector(".task-text");
    if (!input) return;

    input.focus({ preventScroll: true });
    if (typeof start === "number" && typeof end === "number") {
      const s = Math.max(0, Math.min(start, input.value.length));
      const e = Math.max(0, Math.min(end, input.value.length));
      input.setSelectionRange(s, e);
    } else {
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  function renderGuestPrompt() {
    // The dedicated guest auth modal (see #guest-auth-backdrop) covers the
    // whole app with a blurred overlay, so the tasks field stays empty for
    // signed-out visitors instead of duplicating the call-to-action here.
    tasksFieldRoot.innerHTML = "";
  }

  function render() {
    if (!isAuthed) {
      renderGuestPrompt();
      return;
    }

    // Keep the on-disk cache in sync with the live view so reloads (and offline
    // edits) survive without a network round-trip. Only write when the visible
    // tasks belong to the active workspace (avoids polluting another tab's cache).
    if (authUserId) {
      const wsId = getActiveWorkspaceId();
      if (wsId && tasksWorkspaceId === wsId) {
        writeTasksCache(
          generalTasksCacheKey(authUserId, getVisibleWeekMondayIso(), wsId),
          state.tasks
        );
      }
    }

    const beforeRects = captureTaskRowRects(tasksFieldRoot);
    tasksFieldRoot.innerHTML = "";

    const list = document.createElement("div");
    list.className = "tasks-list";

    // Index of the first completed main row (subtasks excluded). That row gets
    // `margin-top: auto` so the completed pile is pinned to the bottom; a
    // pure-CSS sibling selector can't express "first completed main with any
    // mix of subtasks ahead of it", so we mark it from JS.
    const firstCompletedMainIdx = state.tasks.findIndex(
      (t) => t.checked && !t.subtask
    );

    for (let i = 0; i < state.tasks.length; i++) {
      const task = state.tasks[i];
      const taskId = task.id;
      const row = document.createElement("div");
      row.className = `task-row${task.checked ? " completed" : ""}${
        task.subtask ? " task-row-sub" : ""
      }${i === firstCompletedMainIdx ? " task-row-completed-anchor" : ""}`;
      row.dataset.id = taskId;

      const checkbox = document.createElement("button");
      checkbox.type = "button";
      checkbox.className = `task-checkbox${task.checked ? " checked" : ""}`;
      checkbox.setAttribute("aria-label", "Toggle task");

      const input = document.createElement("textarea");
      input.rows = 1;
      input.className = "task-text";
      input.value = task.text;
      input.autocomplete = "off";
      autoSizeTextarea(input);
      input.addEventListener("focus", () => autoSizeTextarea(input));

      applyTaskRowColor(row, task.color);

      const commitBtn = document.createElement("button");
      commitBtn.type = "button";
      commitBtn.className = "task-commit";
      commitBtn.setAttribute("aria-label", "Done");

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "task-delete";
      deleteBtn.setAttribute("aria-label", "Delete task");

      const colorBtn = createTaskColorButton();
      syncTaskColorButton(colorBtn, task.color);

      const dragHandle = createTaskDragHandle();

      const main = document.createElement("div");
      main.className = "task-main";
      main.appendChild(input);

      const actions = document.createElement("div");
      actions.className = "task-row-actions";
      actions.appendChild(commitBtn);
      actions.appendChild(deleteBtn);
      actions.appendChild(colorBtn);
      actions.appendChild(dragHandle);

      row.appendChild(checkbox);
      row.appendChild(main);
      row.appendChild(actions);
      list.appendChild(row);

      checkbox.addEventListener("mousedown", (e) => {
        e.preventDefault();
      });

      commitBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
      });
      commitBtn.addEventListener("click", async () => {
        const ok = await commitTask(taskId);
        if (!ok) return;
        input.blur();
      });

      deleteBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
      });
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        removeTaskRow(taskId);
      });

      colorBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const idx = getTaskIndex(taskId);
        if (idx === -1) return;
        if (activeColorPicker?.rowEl === row) {
          closeTaskColorPicker(true);
          return;
        }
        const current = state.tasks[idx].color;
        row.classList.add("task-row-color-open");
        openTaskColorPicker(
          colorBtn,
          current,
          (next) => {
            const i2 = getTaskIndex(taskId);
            if (i2 === -1) return;
            const t = state.tasks[i2];
            const nc = normalizeTaskColor(next);
            if (t.color === nc) return;
            t.color = nc;
            const liveRow = tasksFieldRoot.querySelector(`.task-row[data-id="${taskId}"]`);
            const liveColorBtn = liveRow?.querySelector(".task-color");
            applyTaskRowColor(liveRow || row, nc);
            syncTaskColorButton(liveColorBtn || colorBtn, nc);
            if (!isTaskEmptyText(t.text)) {
              markTaskDirty(t);
              void persistTask(t);
            }
          },
          input,
          row
        );
      });

      input.addEventListener(
        "keydown",
        (e) => {
          if (!isAuthed) return;
          if (!isTabNavigationKey(e)) return;
          e.preventDefault();
          e.stopImmediatePropagation();
          const idx = getTaskIndex(taskId);
          if (idx === -1) return;
          const task = state.tasks[idx];
          if (e.shiftKey) {
            task.subtask = false;
          } else if (canIndentAsSubtask(state.tasks, idx)) {
            task.subtask = true;
            moveSubtaskUnderImmediateRowAbove(state.tasks, idx);
          }
          normalizeSubtaskFlags(state.tasks);
          if (!isTaskEmptyText(task.text)) {
            markTaskDirty(task);
            void (async () => {
              await persistTask(task);
            })();
          }
          schedulePersistTaskPositions();
          state.focusAfterRender = {
            id: task.id,
            start: e.target.selectionStart,
            end: e.target.selectionEnd,
          };
          render();
        },
        true
      );

      wireTaskDragHandle(
        dragHandle,
        row,
        isAuthed,
        (e) => {
          const input = row.querySelector(".task-text");
          if (input) {
            task.text = input.value;
            markTaskDirty(task);
            normalizeSubtaskFlags(state.tasks);
          }
          state.isDragging = true;
          state.draggedId = taskId;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", taskId);
          const dragPl = buildDragPayload(task);
          setGlobalDragPayload(dragPl);
          writeDragPayloadToDataTransfer(e.dataTransfer, dragPl);
        },
        () => {
          state.isDragging = false;
          state.draggedId = null;
          clearGlobalDragPayload();
        }
      );

      row.addEventListener("drop", (e) => {
        e.preventDefault();
        hideAllTaskDropIndicators();
        if (!isAuthed) return;
        const crossPayload = readDragPayloadFromEvent(e);
        if (crossPayload && crossPayload.sourceBlock !== GENERAL_BLOCK_ID) return;
        const fromId = state.draggedId || e.dataTransfer.getData("text/plain");
        const toId = task.id;
        state.draggedId = null;
        state.isDragging = false;
        if (!fromId || fromId === toId) return;

        const from = getTaskIndex(fromId);
        const to = getTaskIndex(toId);
        if (from === -1 || to === -1) return;

        const insertBefore = taskRowInsertBefore(e, row);
        const moved = reorderTaskInArray(state.tasks, from, to, insertBefore);
        if (!moved) return;

        normalizeSubtaskFlags(state.tasks);
        schedulePersistTaskPositions();

        state.focusAfterRender = { id: moved.id };
        render();
      });

      input.addEventListener("blur", () => {
        if (state.isDragging || taskDragInteractionActive) return;
        if (activeColorPicker) return;
        void (async () => {
          await commitTask(taskId);
        })();
      });
    }

    tasksFieldRoot.appendChild(list);

    // Recalculate heights after mount so multiline values keep full height.
    tasksFieldRoot.querySelectorAll(".task-text").forEach((el) => {
      autoSizeTextarea(el);
    });

    playTaskRowFlip(tasksFieldRoot, beforeRects);

    if (state.focusAfterRender) {
      const { id, start, end } = state.focusAfterRender;
      state.focusAfterRender = null;
      // Wait for the browser to attach focusable elements.
      requestAnimationFrame(() => focusTask(id, start, end));
    }
  }

  function ensureAtLeastOneTask() {
    if (state.tasks.length === 0) {
      state.tasks.push(createTask("", false));
      render();
    }
  }

  /** Click on empty list area: reuse empty draft row or insert a new one, then focus. */
  function beginNewGeneralTaskFromEmptyClick() {
    void flushAllTaskSaves();
    ensureAtLeastOneTask();
    for (let i = state.tasks.length - 1; i >= 0; i--) {
      const t = state.tasks[i];
      if (!t.checked && isTaskEmptyText(t.text)) {
        state.focusAfterRender = { id: t.id };
        render();
        return;
      }
    }
    const fc = firstCheckedTaskIndex(state.tasks);
    const insertAt = fc === -1 ? state.tasks.length : fc;
    const newTask = createTask("", false, null, false);
    state.tasks.splice(insertAt, 0, newTask);
    state.focusAfterRender = { id: newTask.id };
    render();
  }

  function toggleCheckedAndReorder(id, caret) {
    const idx = getTaskIndex(id);
    if (idx === -1) return;
    const task = toggleAndRepositionTask(state.tasks, idx);

    state.focusAfterRender = {
      id: task.id,
      start: caret?.start,
      end: caret?.end,
    };

    if (!isTaskEmptyText(task.text)) {
      markTaskDirty(task);
      void (async () => {
        await persistTask(task);
      })();
    }
    schedulePersistTaskPositions();
    render();
  }

  function splitPasteIntoTasks(currentId, text) {
    const idx = getTaskIndex(currentId);
    if (idx === -1) return;

    const lines = text.split(/\r?\n/);
    const first = lines[0] ?? "";
    state.tasks[idx].text = first;
    markTaskDirty(state.tasks[idx]);

    const toInsert = [];
    for (let i = 1; i < lines.length; i++) {
      const nt = createTask(lines[i] ?? "", false, null, false);
      markTaskDirty(nt);
      toInsert.push(nt);
    }
    const pasteInsertAt = insertIndexBelowRowUncheckedFirst(state.tasks, idx);
    state.tasks.splice(pasteInsertAt, 0, ...toInsert);

    const focusId =
      toInsert.length > 0 ? state.tasks[pasteInsertAt]?.id ?? currentId : currentId;
    state.focusAfterRender = { id: focusId };
    schedulePersistTaskPositions();
    render();
  }

  tasksFieldRoot.addEventListener(
    "pointerdown",
    (e) => {
      if (!isAuthed) return;
      suppressGeneralEmptyClickNewTask = false;
      const row = e.target.closest?.(".task-row");
      if (row) return;
      if (!tasksFieldRoot.contains(e.target)) return;
      const ae = document.activeElement;
      if (ae && ae.classList?.contains("task-text") && tasksFieldRoot.contains(ae)) {
        suppressGeneralEmptyClickNewTask = true;
      }
    },
    true
  );

  tasksFieldRoot.addEventListener("click", (e) => {
    if (state.isDragging) return;
    if (!isAuthed) return;

    const row = e.target.closest(".task-row");
    if (!row) {
      if (suppressGeneralEmptyClickNewTask) {
        suppressGeneralEmptyClickNewTask = false;
        void flushAllTaskSaves();
        return;
      }
      beginNewGeneralTaskFromEmptyClick();
      return;
    }

    const id = row.dataset.id;
    if (!id) return;

    const isCheckbox = e.target.classList.contains("task-checkbox");
    const isCommit = e.target.classList.contains("task-commit");
    const isDelete = e.target.classList.contains("task-delete");
    const isColor = !!e.target.closest?.(".task-color");
    const isText = e.target.classList.contains("task-text");
    if (!isCheckbox && !isText && !isCommit && !isDelete && !isColor) return;
    if (isCommit || isDelete || isColor) return;

    if (isCheckbox) {
      let caret;
      const input = row.querySelector(".task-text");
      if (input) caret = { start: input.selectionStart, end: input.selectionEnd };
      toggleCheckedAndReorder(id, caret);
      return;
    }

    // Text click enables edit mode only; it must not toggle completion.
    if (isText) {
      e.target.focus();
    }
  });

  tasksFieldRoot.addEventListener("input", (e) => {
    if (!isAuthed) return;
    const input = e.target;
    if (!input.classList || !input.classList.contains("task-text")) return;

    const row = input.closest(".task-row");
    const id = row?.dataset.id;
    if (!id) return;

    const idx = getTaskIndex(id);
    if (idx === -1) return;
    state.tasks[idx].text = input.value;
    markTaskDirty(state.tasks[idx]);
    autoSizeTextarea(input);
  });

  tasksFieldRoot.addEventListener("keydown", (e) => {
    if (!isAuthed) return;
    const input = e.target;
    if (!input.classList || !input.classList.contains("task-text")) return;

    const row = input.closest(".task-row");
    const id = row?.dataset.id;
    if (!id) return;

    const idx = getTaskIndex(id);
    if (idx === -1) return;

    if (e.key !== "Enter") return;
    if (e.shiftKey) return;

    e.preventDefault();

    void (async () => {
      const ok = await commitTask(id);
      if (!ok) return;
      // Enter only saves and leaves edit mode; do not open a new draft row (click empty area for that).
      const active = document.activeElement;
      if (active && active.classList?.contains("task-text") && tasksFieldRoot.contains(active)) {
        active.blur();
      }
    })();
  });

  async function flushFocusedGeneralInput() {
    const active = document.activeElement;
    if (!active || !active.classList || !active.classList.contains("task-text")) return;
    if (!tasksFieldRoot.contains(active)) return;
    const row = active.closest(".task-row");
    const id = row?.dataset.id;
    if (!id) return;
    await syncTaskFromInput(id);
  }

  async function flushDirtyGeneralTasks() {
    if (!isAuthed || !authUserId) return;
    for (const t of state.tasks) {
      if (!t._dirty) continue;
      if (isTaskEmptyText(t.text) && !t.dbId) {
        t._dirty = false;
        continue;
      }
      await persistTask(t);
    }
  }

  registerTaskSaveFlush(async () => {
    await flushFocusedGeneralInput();
    await flushDirtyGeneralTasks();
  });

  // When the network comes back, retry pending writes and re-pull the week so
  // we can merge in anything other devices changed while we were offline.
  onNetworkRetry(async () => {
    if (!isAuthed) return;
    await flushDirtyGeneralTasks();
    await loadTasksForUser();
  });

  tasksFieldRoot.addEventListener("paste", (e) => {
    if (!isAuthed) return;
    const input = e.target;
    if (!input.classList || !input.classList.contains("task-text")) return;

    const text = e.clipboardData?.getData("text") ?? "";
    if (!text || !text.includes("\n")) return;

    e.preventDefault();

    const row = input.closest(".task-row");
    const id = row?.dataset.id;
    if (!id) return;

    splitPasteIntoTasks(id, text);
  });

  tasksField.addEventListener("dragover", (e) => {
    if (!isAuthed || !isActiveTaskDragEvent(e)) return;
    const list = tasksFieldRoot.querySelector(".tasks-list");
    if (!list) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const payload = readDragPayloadFromEvent(e);
    if (payload && payload.sourceBlock !== GENERAL_BLOCK_ID) {
      const insertAt = computeCrossInsertIndex(
        state.tasks,
        getTaskIndex,
        e,
        list,
        !!payload.checked
      );
      showCrossDropIndicator(generalDropIndicator, list, insertAt);
      return;
    }
    updateTaskDropIndicator(
      tasksField,
      generalDropIndicator,
      list,
      e,
      state.draggedId,
      getTaskIndex
    );
  });

  tasksField.addEventListener("dragleave", (e) => {
    const related = e.relatedTarget;
    if (related && tasksField.contains(related)) return;
    generalDropIndicator.hide();
  });

  tasksField.addEventListener(
    "drop",
    async (e) => {
      if (!isAuthed) return;

      const payload = readDragPayloadFromEvent(e);
      if (!payload || payload.sourceBlock === GENERAL_BLOCK_ID) return;

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      const list = tasksFieldRoot.querySelector(".tasks-list");
      const insertAt = computeCrossInsertIndex(
        state.tasks,
        getTaskIndex,
        e,
        list,
        !!payload.checked
      );

      hideAllTaskDropIndicators();

      const text = String(payload.text ?? "");
      const checked = !!payload.checked;
      const sub = !!payload.subtask;
      const color = normalizeTaskColor(payload.color);
      const safeInsertAt = Math.max(0, Math.min(insertAt, state.tasks.length));

      // Update both panels synchronously before any await — otherwise the
      // source row snaps back while flush/relocate runs.
      window.dispatchEvent(
        new CustomEvent("task-cross-move", {
          detail: {
            sourceBlock: payload.sourceBlock,
            sourceLocalId: payload.localId,
            targetBlock: GENERAL_BLOCK_ID,
          },
        })
      );

      const moved = createTask(text, checked, payload.dbId || null, sub, color);
      state.tasks.splice(safeInsertAt, 0, moved);
      schedulePersistTaskPositions();
      state.focusAfterRender = { id: moved.id };
      render();

      await flushAllTaskSaves();

      if (payload.dbId) {
        const { ok, error } = await supabaseRelocateTaskRow(supabase, authUserId, payload.dbId, {
          type: "general",
          day_name: null,
          date: getVisibleWeekMondayIso(),
          content: text,
          completed: checked,
          is_subtask: sub,
          color,
          workspace_id: getActiveWorkspaceId(),
          position: safeInsertAt,
        });
        if (!ok) {
          console.error("Supabase move-to-general failed:", error);
          return;
        }
      }

      if (!payload.dbId && !isTaskEmptyText(text)) {
        markTaskDirty(moved);
        await persistTask(moved);
      }

      clearGlobalDragPayload();
      void flushAllTaskSaves();
    },
    true
  );

  window.addEventListener("task-cross-move", (e) => {
    const detail = e.detail || {};
    if (detail.sourceBlock !== GENERAL_BLOCK_ID) return;
    if (detail.targetBlock === GENERAL_BLOCK_ID) return;

    const idx = getTaskIndex(detail.sourceLocalId);
    if (idx === -1) return;
    state.tasks.splice(idx, 1);
    render();
  });

  window.addEventListener(WEEK_CHANGE_EVENT, () => {
    if (!isAuthed || !authUserId) return;
    void loadTasksForUser();
    updateMoveRemainingBtn();
  });

  window.addEventListener("workspace-change", () => {
    if (!isAuthed || !authUserId) return;
    void loadTasksForUser();
    updateMoveRemainingBtn();
  });

  /**
   * "Move remaining tasks" — на текущей неделе показывает кнопку, которая
   * копирует все невыполненные general-задачи прошлой недели в текущую.
   * Используется именно копирование (не перемещение), чтобы прошлая неделя
   * сохранилась как исторический срез.
   */
  const moveRemainingBtn = document.getElementById("tasks-move-remaining");

  function moveRemainingDoneKey(userId, weekIso, workspaceId) {
    const ws = workspaceId ? `-${workspaceId}` : "";
    return `oneweek-move-remaining-done-${userId}-${weekIso}${ws}`;
  }

  function isMoveRemainingDone(userId, weekIso, workspaceId) {
    if (!userId) return false;
    try {
      return (
        localStorage.getItem(moveRemainingDoneKey(userId, weekIso, workspaceId)) === "1"
      );
    } catch {
      return false;
    }
  }

  function markMoveRemainingDone(userId, weekIso, workspaceId) {
    if (!userId) return;
    try {
      localStorage.setItem(moveRemainingDoneKey(userId, weekIso, workspaceId), "1");
    } catch {
      /* storage blocked */
    }
  }

  function updateMoveRemainingBtn() {
    if (!moveRemainingBtn) return;
    const offset = Number(window.__weekOffset || 0);
    const weekIso = getVisibleWeekMondayIso();
    const workspaceId = getActiveWorkspaceId();
    const shouldShow =
      isAuthed &&
      offset === 0 &&
      !isMoveRemainingDone(authUserId, weekIso, workspaceId);
    moveRemainingBtn.hidden = !shouldShow;
  }

  async function moveRemainingFromLastWeek() {
    if (!supabase || !isAuthed || !authUserId) return;
    if (Number(window.__weekOffset || 0) !== 0) return;

    const workspaceId = getActiveWorkspaceId();
    const lastWeekIso = toIsoDateFromDate(getWeekMondayStart(new Date(), -1));
    const currentWeekIso = getVisibleWeekMondayIso();

    let query = supabase
      .from("tasks")
      .select("content, is_subtask, color, position")
      .eq("user_id", authUserId)
      .eq("type", "general")
      .eq("date", lastWeekIso)
      .eq("completed", false);
    if (workspaceId) query = query.eq("workspace_id", workspaceId);

    const { data, error } = await query
      .order("position", { ascending: true })
      .order("created_at", { ascending: true });

    if (error) {
      markNetworkFailure(error);
      console.error("Move remaining: load failed:", error);
      return;
    }
    markNetworkSuccess();

    const rows = (data ?? []).filter((r) => !isTaskEmptyText(r.content));
    if (rows.length === 0) {
      markMoveRemainingDone(authUserId, currentWeekIso, workspaceId);
      return;
    }

    await flushAllTaskSaves();

    const basePosition = state.tasks.length;
    const inserts = rows.map((row, i) => {
      const payload = {
        user_id: authUserId,
        content: String(row.content ?? ""),
        completed: false,
        type: "general",
        date: currentWeekIso,
        is_subtask: !!row.is_subtask,
        color: normalizeTaskColor(row.color),
        position: basePosition + i,
      };
      if (workspaceId) payload.workspace_id = workspaceId;
      return payload;
    });

    const { data: inserted, error: insertErr } = await supabase
      .from("tasks")
      .insert(inserts)
      .select("id");

    if (insertErr) {
      markNetworkFailure(insertErr);
      console.error("Move remaining: insert failed:", insertErr);
      return;
    }
    markNetworkSuccess();

    const newTasks = rows.map((row, i) => ({
      id: `task-${state.nextId++}`,
      dbId: inserted?.[i]?.id ?? null,
      text: String(row.content ?? ""),
      checked: false,
      subtask: !!row.is_subtask,
      color: normalizeTaskColor(row.color),
      position: basePosition + i,
      _dirty: false,
    }));

    state.tasks = [...state.tasks, ...newTasks];
    normalizeSubtaskFlags(state.tasks);
    state.tasks = partitionUncheckedBeforeChecked(state.tasks);
    syncPositionsFromArray(state.tasks);
    render();

    markMoveRemainingDone(authUserId, currentWeekIso, workspaceId);
  }

  if (moveRemainingBtn) {
    moveRemainingBtn.addEventListener("click", async () => {
      if (moveRemainingBtn.disabled) return;
      moveRemainingBtn.disabled = true;
      try {
        await moveRemainingFromLastWeek();
      } finally {
        moveRemainingBtn.disabled = false;
        updateMoveRemainingBtn();
      }
    });
  }
  updateMoveRemainingBtn();

  void initAuth();
})();

(() => {
  const dayRects = document.querySelectorAll(".day-rect");
  if (dayRects.length === 0) return;
  const supabase = window.supabaseClient;

  function getDayMeta(dayName) {
    const weekStart = getVisibleWeekStartDate();
    const indexMap = {
      Monday: 0,
      Tuesday: 1,
      Wednesday: 2,
      Thursday: 3,
      Friday: 4,
      Saturday: 5,
      Sunday: 6,
    };

    if (dayName === "Next week") {
      const nextMonday = new Date(weekStart);
      nextMonday.setDate(weekStart.getDate() + 7);
      return { dayName, date: toIsoDateFromDate(nextMonday) };
    }

    const idx = indexMap[dayName];
    const date = new Date(weekStart);
    date.setDate(weekStart.getDate() + (idx ?? 0));
    return { dayName, date: toIsoDateFromDate(date) };
  }

  function parseTimeMinutes(text) {
    // Recognize the first hh:mm occurrence anywhere in the task text.
    const match = String(text ?? "").match(/\b(\d{1,2}):(\d{2})\b/);
    if (!match) return null;
    const hh = Number(match[1]);
    const mm = Number(match[2]);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    if (hh < 0 || hh > 23) return null;
    if (mm < 0 || mm > 59) return null;
    return hh * 60 + mm;
  }

  /** First valid hh:mm in the string is moved to the start (normalized to HH:mm). */
  function moveTimeToStart(text) {
    const s = String(text ?? "");
    const re = /\b(\d{1,2}):(\d{2})\b/;
    const match = s.match(re);
    if (!match) return s;
    const hh = Number(match[1]);
    const mm = Number(match[2]);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return s;
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return s;

    const timeLabel = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    const matched = match[0];
    const start = match.index ?? 0;
    const rest = (s.slice(0, start) + s.slice(start + matched.length))
      .replace(/\s+/g, " ")
      .trim();
    return rest ? `${timeLabel} ${rest}` : timeLabel;
  }

  function setupDay(dayRect) {
    const tasksEl = dayRect.querySelector(".day-tasks");
    if (!tasksEl) return;
    const dayName = dayRect.dataset.day || "";
    let dayMeta = getDayMeta(dayName);
    const blockId = `day:${dayName}`;
    /** Slug used in DOM ids so the same numeric suffix never collides across day columns. */
    const daySlugForId = String(dayName).replace(/\s+/g, "-");

    const state = {
      tasks: [],
      nextId: 1,
      draggedId: null,
      isDragging: false,
      focusAfterRender: null, // { id, start, end }
    };
    let currentUserId = null;
    let isAuthed = false;
    let dayLoadGen = 0;
    let tasksWorkspaceId = null;
    /** Empty-area click while a task field was focused: save only, no new draft. */
    let suppressDayEmptyClickNewPlan = false;
    const dayDropIndicator = createTaskDropIndicator(dayRect, tasksEl);

    function createTask(text = "", checked = false, dbId = null, subtask = false, color = null) {
      const id = `d-${daySlugForId}-${state.nextId++}`;
      return {
        id,
        dbId,
        text,
        checked,
        subtask: !!subtask,
        color: normalizeTaskColor(color),
        _dirty: false,
      };
    }

    function buildDragPayload(task) {
      return {
        sourceBlock: blockId,
        localId: task.id,
        dbId: task.dbId ?? null,
        text: task.text ?? "",
        checked: !!task.checked,
        subtask: !!task.subtask,
        color: normalizeTaskColor(task.color),
      };
    }

    function setGlobalDragPayload(payload) {
      window.__dragTaskPayload = payload;
    }

    function getGlobalDragPayload() {
      return window.__dragTaskPayload || null;
    }

    function clearGlobalDragPayload() {
      window.__dragTaskPayload = null;
    }

    function getTaskIndex(id) {
      return state.tasks.findIndex((t) => t.id === id);
    }

    async function deleteTaskFromDb(task) {
      if (!supabase || !isAuthed || !currentUserId || !task?.dbId) return;

      const { error } = await supabase
        .from("tasks")
        .delete()
        .eq("id", task.dbId)
        .eq("user_id", currentUserId);

      if (error) {
        markNetworkFailure(error);
        console.error("Supabase daily delete failed:", error);
        throw error;
      }
      markNetworkSuccess();
      task.dbId = null;
    }

    async function insertOrUpdateTaskInDb(task, snapshot) {
      if (!supabase || !isAuthed || !currentUserId || !task) return;
      const source = snapshot || task;
      const content = String(source.text ?? "");
      const completed = !!source.checked;
      const isSubtask = !!source.subtask;
      const color = normalizeTaskColor(source.color);
      const dbId = source.dbId ?? task.dbId ?? null;

      // Never auto-delete on empty text. Drafts without dbId are no-ops.
      if (isTaskEmptyText(content) && !dbId) {
        return;
      }

      const idx = taskIndexInList(state.tasks, task);
      const position = idx >= 0 ? idx : state.tasks.length;

      if (dbId) {
        const { error } = await supabase
          .from("tasks")
          .update({
            content,
            completed,
            is_subtask: isSubtask,
            color,
            position,
          })
          .eq("id", dbId)
          .eq("user_id", currentUserId);

        if (error) {
          markNetworkFailure(error);
          console.error("Supabase daily update failed:", error);
          throw error;
        }
        markNetworkSuccess();
        return;
      }

      const workspaceId = getActiveWorkspaceId();
      const insertPayload = {
        user_id: currentUserId,
        content,
        completed,
        type: "daily",
        day_name: dayMeta.dayName,
        date: dayMeta.date,
        is_subtask: isSubtask,
        color,
        position,
      };
      if (workspaceId) insertPayload.workspace_id = workspaceId;

      const { data, error } = await supabase
        .from("tasks")
        .insert(insertPayload)
        .select("id")
        .single();

      if (error) {
        markNetworkFailure(error);
        console.error("Supabase daily insert failed:", error);
        throw error;
      }

      markNetworkSuccess();
      task.dbId = data?.id ?? null;
      task.position = position;
    }

    const persistTask = createPersistTask(
      insertOrUpdateTaskInDb,
      "Supabase daily persist failed:",
      () => {
        if (!currentUserId) return;
        const wsId = getActiveWorkspaceId();
        if (!wsId || tasksWorkspaceId !== wsId) return;
        writeTasksCache(
          dailyTasksCacheKey(
            currentUserId,
            dayMeta.dayName,
            dayMeta.date,
            wsId
          ),
          state.tasks
        );
      }
    );

    const schedulePersistTaskPositions = createPositionPersistScheduler(
      supabase,
      () => currentUserId,
      () => state.tasks
    );

    function applyCachedDayTasks() {
      if (!currentUserId) return false;
      const workspaceId = getActiveWorkspaceId();
      const cached = readTasksCache(
        dailyTasksCacheKey(currentUserId, dayMeta.dayName, dayMeta.date, workspaceId)
      );
      if (!cached) return false;
      state.tasks = cached.map((row, i) => ({
        id: `d-${daySlugForId}-${state.nextId++}`,
        dbId: row.dbId ?? null,
        text: moveTimeToStart(row.text ?? ""),
        checked: !!row.checked,
        subtask: !!row.subtask,
        color: normalizeTaskColor(row.color),
        position: typeof row.position === "number" ? row.position : i,
        _dirty: !!row.dirty,
      }));
      normalizeSubtaskFlags(state.tasks);
      return true;
    }

    /** See the general-panel version above for the rationale; this is the
     *  daily-panel mirror. Daily tasks also pass through `stabilizeTimeSorted`
     *  after the merge, so timed rows still snap into the time-sorted order. */
    function mergeLocalEditsIntoServerSnapshot(serverTasks, localBefore) {
      const serverByDbId = new Map();
      for (const s of serverTasks) {
        if (s.dbId) serverByDbId.set(s.dbId, s);
      }

      const usedDbIds = new Set();
      const result = [];

      function contentKey(t) {
        return `${moveTimeToStart(String(t.text ?? "")).trim()}|${t.checked ? 1 : 0}|${t.subtask ? 1 : 0}`;
      }
      const unusedServerByContent = new Map();
      for (const srv of serverTasks) {
        if (!srv.dbId) continue;
        const k = contentKey(srv);
        if (!unusedServerByContent.has(k)) unusedServerByContent.set(k, []);
        unusedServerByContent.get(k).push(srv);
      }

      for (const local of localBefore) {
        if (local.dbId) {
          const srv = serverByDbId.get(local.dbId);
          if (!srv) {
            if (local._dirty && !isTaskEmptyText(local.text)) {
              result.push({ ...local, dbId: null });
              const bucket = unusedServerByContent.get(contentKey(local));
              if (bucket && bucket.length) bucket.shift();
            }
            continue;
          }
          usedDbIds.add(local.dbId);
          const bucket = unusedServerByContent.get(contentKey(srv));
          if (bucket) {
            const idx = bucket.indexOf(srv);
            if (idx !== -1) bucket.splice(idx, 1);
          }
          if (local._dirty) {
            result.push({
              ...srv,
              id: local.id,
              text: local.text,
              checked: local.checked,
              subtask: local.subtask,
              color: normalizeTaskColor(local.color),
              _dirty: true,
            });
          } else {
            result.push({ ...srv, id: local.id });
          }
        } else if (!isTaskEmptyText(local.text)) {
          const k = contentKey(local);
          const bucket = unusedServerByContent.get(k);
          const match = bucket && bucket.length ? bucket.shift() : null;
          if (match) {
            usedDbIds.add(match.dbId);
            result.push({ ...match, id: local.id });
          } else if (local._dirty) {
            result.push({
              id: local.id,
              dbId: null,
              text: local.text,
              checked: !!local.checked,
              subtask: !!local.subtask,
              color: normalizeTaskColor(local.color),
              _dirty: true,
            });
          }
        }
      }

      for (const srv of serverTasks) {
        if (!srv.dbId || usedDbIds.has(srv.dbId)) continue;
        result.push(srv);
      }

      return result;
    }

    async function loadTasksForDay() {
      if (!supabase || !isAuthed || !currentUserId) return;

      const loadGen = ++dayLoadGen;
      const cachedDayName = dayMeta.dayName;
      const cachedDate = dayMeta.date;
      const cachedWorkspaceId = getActiveWorkspaceId();
      tasksWorkspaceId = null;

      // Paint the cache before the network call. If there's nothing cached for
      // this day, clear the list so we never show stale data from another day.
      const hadCache = applyCachedDayTasks();
      if (!hadCache) state.tasks = [];
      render();

      let dayQuery = supabase
        .from("tasks")
        .select("id, content, completed, created_at, is_subtask, color, position")
        .eq("user_id", currentUserId)
        .eq("type", "daily")
        .eq("day_name", cachedDayName)
        .eq("date", cachedDate);
      if (cachedWorkspaceId) dayQuery = dayQuery.eq("workspace_id", cachedWorkspaceId);
      const { data, error } = await dayQuery
        .order("position", { ascending: true })
        .order("created_at", { ascending: true });

      if (error) {
        markNetworkFailure(error);
        console.error("Supabase daily load failed (keeping cached tasks):", error);
        return;
      }
      markNetworkSuccess();

      // If the user navigated to another week (or workspace) while the request
      // was in flight, dayMeta/active id has already changed — don't clobber
      // the fresh state.
      if (dayMeta.dayName !== cachedDayName || dayMeta.date !== cachedDate) return;
      if (getActiveWorkspaceId() !== cachedWorkspaceId) return;
      if (loadGen !== dayLoadGen) return;

      const localBefore = state.tasks;
      const serverTasks = (data ?? []).map((row) => ({
        id: `d-${daySlugForId}-${state.nextId++}`,
        dbId: row.id,
        text: moveTimeToStart(row.content ?? ""),
        checked: !!row.completed,
        subtask: !!row.is_subtask,
        color: normalizeTaskColor(row.color),
        position: row.position ?? 0,
        _dirty: false,
      }));
      state.tasks = mergeLocalEditsIntoServerSnapshot(serverTasks, localBefore);
      normalizeSubtaskFlags(state.tasks);
      stabilizeTimeSorted();
      syncPositionsFromArray(state.tasks);
      tasksWorkspaceId = cachedWorkspaceId;
      writeTasksCache(
        dailyTasksCacheKey(currentUserId, cachedDayName, cachedDate, cachedWorkspaceId),
        state.tasks
      );
      render();

      // Network is back — retry any waiting offline edits.
      for (const t of state.tasks) {
        if (t._dirty) void persistTask(t);
      }
    }

    function focusTask(id, start, end) {
      const row = tasksEl.querySelector(`.task-row[data-id="${id}"]`);
      if (!row) return;
      const input = row.querySelector(".task-text");
      if (!input) return;

      input.focus({ preventScroll: true });
      if (typeof start === "number" && typeof end === "number") {
        const s = Math.max(0, Math.min(start, input.value.length));
        const e = Math.max(0, Math.min(end, input.value.length));
        input.setSelectionRange(s, e);
      } else {
        input.setSelectionRange(input.value.length, input.value.length);
      }
    }

    function removeTaskRow(taskId) {
      const idx = getTaskIndex(taskId);
      if (idx === -1) return;
      const task = state.tasks[idx];

      oneweekPushUndo({
        blockId,
        type: "delete",
        dayName: dayMeta.dayName,
        date: dayMeta.date,
        workspaceId: getActiveWorkspaceId(),
        userId: currentUserId,
        position: idx,
        snapshot: {
          text: task.text,
          checked: !!task.checked,
          subtask: !!task.subtask,
          color: normalizeTaskColor(task.color),
        },
      });

      if (task.dbId) void deleteTaskFromDb(task);
      state.focusAfterRender = null;
      state.tasks.splice(idx, 1);
      stabilizeTimeSorted();
      schedulePersistTaskPositions();
      render();
    }

    oneweekRegisterUndoHandler(blockId, async (entry) => {
      if (entry.type !== "delete") return false;
      if (!currentUserId || entry.userId !== currentUserId) return false;
      if (entry.dayName !== dayMeta.dayName || entry.date !== dayMeta.date) {
        return false;
      }
      if ((entry.workspaceId || null) !== (getActiveWorkspaceId() || null)) {
        return false;
      }
      const s = entry.snapshot || {};
      const restored = createTask(
        moveTimeToStart(s.text ?? ""),
        !!s.checked,
        null,
        !!s.subtask,
        normalizeTaskColor(s.color)
      );
      const at = Math.max(0, Math.min(entry.position ?? state.tasks.length, state.tasks.length));
      state.tasks.splice(at, 0, restored);
      stabilizeTimeSorted();
      normalizeSubtaskFlags(state.tasks);
      state.focusAfterRender = { id: restored.id };
      if (!isTaskEmptyText(restored.text)) {
        markTaskDirty(restored);
        void persistTask(restored);
      }
      schedulePersistTaskPositions();
      render();
      return true;
    });

    async function syncTaskFromInput(taskId) {
      const idx = getTaskIndex(taskId);
      if (idx === -1) return { needRender: true };
      const row = tasksEl.querySelector(`.task-row[data-id="${taskId}"]`);
      const input = row?.querySelector(".task-text");
      if (!input) return { needRender: true };
      let currentText = moveTimeToStart(input.value);
      if (currentText !== input.value) input.value = currentText;
      const task = state.tasks[idx];
      task.text = currentText;
      normalizeSubtaskFlags(state.tasks);
      if (isTaskEmptyText(currentText)) {
        if (!task.dbId) {
          state.focusAfterRender = null;
          state.tasks.splice(idx, 1);
          stabilizeTimeSorted();
          return { needRender: true };
        }
        // Persisted row that was emptied: keep it; only the trash button deletes.
        void persistTask(task);
        return { needRender: false };
      }
      // Time-tasks differ only by ordering: sort timed tasks among themselves on commit.
      stabilizeTimeSorted();
      schedulePersistTaskPositions();
      const taskAfterSort = state.tasks.find((t) => t.id === taskId);
      if (!taskAfterSort) return { needRender: true };
      // Do not await: keep commit/reorder instant; persist runs in background.
      void persistTask(taskAfterSort);
      return { needRender: false };
    }

    async function commitTask(taskId) {
      const { needRender } = await syncTaskFromInput(taskId);
      render();
      return !needRender;
    }

    function stabilizeTimeSorted() {
      // Keep untimed tasks in their current index "slots",
      // and sort only timed tasks (smaller time = higher position).
      const info = state.tasks.map((t, index) => ({
        task: t,
        index,
        minutes: parseTimeMinutes(t.text),
      }));

      const untimedIndices = new Set();
      const untimedTasksInOrder = [];
      const timedTasks = [];

      for (const item of info) {
        if (item.minutes == null) {
          untimedIndices.add(item.index);
          untimedTasksInOrder.push(item.task);
        } else {
          timedTasks.push({ task: item.task, minutes: item.minutes, index: item.index });
        }
      }

      timedTasks.sort((a, b) => (a.minutes - b.minutes) || (a.index - b.index));

      const result = [];
      let u = 0;
      let t = 0;

      for (let i = 0; i < state.tasks.length; i++) {
        if (untimedIndices.has(i)) {
          result.push(untimedTasksInOrder[u++]);
        } else {
          result.push(timedTasks[t++].task);
        }
      }

      state.tasks = partitionUncheckedBeforeChecked(result);
    }

    function render() {
      const beforeRects = captureTaskRowRects(tasksEl);
      tasksEl.innerHTML = "";

      // Keep the cache aligned with the live view (offline edits survive reload).
      if (isAuthed && currentUserId) {
        const wsId = getActiveWorkspaceId();
        if (wsId && tasksWorkspaceId === wsId) {
          writeTasksCache(
            dailyTasksCacheKey(
              currentUserId,
              dayMeta.dayName,
              dayMeta.date,
              wsId
            ),
            state.tasks
          );
        }
      }

      const list = document.createElement("div");
      list.className = "tasks-list";

      // See the general-panel render for the rationale behind the anchor class.
      const firstCompletedMainIdx = state.tasks.findIndex(
        (t) => t.checked && !t.subtask
      );

      for (let i = 0; i < state.tasks.length; i++) {
        const task = state.tasks[i];
        const taskId = task.id;

        const row = document.createElement("div");
        row.className = `task-row${task.checked ? " completed" : ""}${
          task.subtask ? " task-row-sub" : ""
        }${i === firstCompletedMainIdx ? " task-row-completed-anchor" : ""}`;
        row.dataset.id = taskId;

        const checkbox = document.createElement("button");
        checkbox.type = "button";
        checkbox.className = `task-checkbox${task.checked ? " checked" : ""}`;
        checkbox.setAttribute("aria-label", "Toggle task");

        const input = document.createElement("textarea");
        input.rows = 1;
        input.className = "task-text";
        input.value = task.text;
        input.autocomplete = "off";
        autoSizeTextarea(input);
        input.addEventListener("focus", () => autoSizeTextarea(input));

        const main = document.createElement("div");
        main.className = "task-main";
        main.appendChild(input);

        applyTaskRowColor(row, task.color);

        const commitBtn = document.createElement("button");
        commitBtn.type = "button";
        commitBtn.className = "task-commit";
        commitBtn.setAttribute("aria-label", "Done");

        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "task-delete";
        deleteBtn.setAttribute("aria-label", "Delete task");

        const colorBtn = createTaskColorButton();
        syncTaskColorButton(colorBtn, task.color);

        const dragHandle = createTaskDragHandle();

        const actions = document.createElement("div");
        actions.className = "task-row-actions";
        actions.appendChild(commitBtn);
        actions.appendChild(deleteBtn);
        actions.appendChild(colorBtn);
        actions.appendChild(dragHandle);

        row.appendChild(checkbox);
        row.appendChild(main);
        row.appendChild(actions);
        list.appendChild(row);

        checkbox.addEventListener("mousedown", (e) => {
          e.preventDefault();
        });

        commitBtn.addEventListener("mousedown", (e) => {
          e.preventDefault();
        });
        commitBtn.addEventListener("click", async () => {
          const ok = await commitTask(taskId);
          if (!ok) return;
          input.blur();
        });

        deleteBtn.addEventListener("mousedown", (e) => {
          e.preventDefault();
        });
        deleteBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          removeTaskRow(taskId);
        });

        colorBtn.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const idx = getTaskIndex(taskId);
          if (idx === -1) return;
          if (activeColorPicker?.rowEl === row) {
            closeTaskColorPicker(true);
            return;
          }
          const current = state.tasks[idx].color;
          row.classList.add("task-row-color-open");
          openTaskColorPicker(
            colorBtn,
            current,
            (next) => {
              const i2 = getTaskIndex(taskId);
              if (i2 === -1) return;
              const t = state.tasks[i2];
              const nc = normalizeTaskColor(next);
              if (t.color === nc) return;
              t.color = nc;
              const liveRow = tasksEl.querySelector(`.task-row[data-id="${taskId}"]`);
              const liveColorBtn = liveRow?.querySelector(".task-color");
              applyTaskRowColor(liveRow || row, nc);
              syncTaskColorButton(liveColorBtn || colorBtn, nc);
              if (!isTaskEmptyText(t.text)) {
                markTaskDirty(t);
                void persistTask(t);
              }
            },
            input,
            row
          );
        });

        input.addEventListener(
          "keydown",
          (e) => {
            if (!isAuthed) return;
            if (!isTabNavigationKey(e)) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            const idx = getTaskIndex(taskId);
            if (idx === -1) return;
            const task = state.tasks[idx];
            if (e.shiftKey) {
              task.subtask = false;
            } else if (canIndentAsSubtask(state.tasks, idx)) {
              task.subtask = true;
              moveSubtaskUnderImmediateRowAbove(state.tasks, idx);
            }
            normalizeSubtaskFlags(state.tasks);
            if (!isTaskEmptyText(task.text)) {
              markTaskDirty(task);
              void (async () => {
                await persistTask(task);
              })();
            }
            schedulePersistTaskPositions();
            state.focusAfterRender = {
              id: task.id,
              start: e.target.selectionStart,
              end: e.target.selectionEnd,
            };
            render();
          },
          true
        );

        wireTaskDragHandle(
          dragHandle,
          row,
          isAuthed,
          (e) => {
            const input = row.querySelector(".task-text");
            if (input) {
              let v = moveTimeToStart(input.value);
              if (v !== input.value) input.value = v;
              task.text = v;
              markTaskDirty(task);
            }
            normalizeSubtaskFlags(state.tasks);
            stabilizeTimeSorted();
            const payloadTask =
              state.tasks.find((t) => t.id === taskId) || task;
            state.isDragging = true;
            state.draggedId = taskId;
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", taskId);
            const dragPl = buildDragPayload(payloadTask);
            setGlobalDragPayload(dragPl);
            writeDragPayloadToDataTransfer(e.dataTransfer, dragPl);
          },
          () => {
            state.isDragging = false;
            state.draggedId = null;
            clearGlobalDragPayload();
          }
        );

        row.addEventListener("drop", (e) => {
          e.preventDefault();
          hideAllTaskDropIndicators();
          if (!isAuthed) return;
          const crossPayload = readDragPayloadFromEvent(e);
          if (crossPayload && crossPayload.sourceBlock !== blockId) return;
          const fromId = state.draggedId || e.dataTransfer.getData("text/plain");
          const toId = taskId;
          state.draggedId = null;
          state.isDragging = false;
          if (!fromId || fromId === toId) return;

          const from = getTaskIndex(fromId);
          const to = getTaskIndex(toId);
          if (from === -1 || to === -1) return;

          const insertBefore = taskRowInsertBefore(e, row);
          const moved = reorderTaskInArray(state.tasks, from, to, insertBefore);
          if (!moved) return;

          stabilizeTimeSorted();
          normalizeSubtaskFlags(state.tasks);
          schedulePersistTaskPositions();

          state.focusAfterRender = { id: moved.id };
          render();
        });

        input.addEventListener("blur", () => {
          if (state.isDragging || taskDragInteractionActive) return;
          if (activeColorPicker) return;
          void (async () => {
            await commitTask(taskId);
          })();
        });
      }

      tasksEl.appendChild(list);

      // Recalculate heights after mount so multiline values keep full height.
      tasksEl.querySelectorAll(".task-text").forEach((el) => {
        autoSizeTextarea(el);
      });

      playTaskRowFlip(tasksEl, beforeRects);

      if (state.focusAfterRender) {
        const { id, start, end } = state.focusAfterRender;
        state.focusAfterRender = null;
        requestAnimationFrame(() => focusTask(id, start, end));
      }
    }

    /** Click on empty list area: reuse empty draft row or insert a new one, then focus. */
    function beginNewPlanFromEmptyClick() {
      void flushAllTaskSaves();
      for (let i = state.tasks.length - 1; i >= 0; i--) {
        const t = state.tasks[i];
        if (!t.checked && isTaskEmptyText(t.text)) {
          state.focusAfterRender = { id: t.id };
          render();
          return;
        }
      }
      const fc = firstCheckedTaskIndex(state.tasks);
      const insertAt = fc === -1 ? state.tasks.length : fc;
      const newTask = createTask("", false, null, false);
      state.tasks.splice(insertAt, 0, newTask);
      state.focusAfterRender = { id: newTask.id };
      render();
    }

    function toggleChecked(id) {
      const idx = getTaskIndex(id);
      if (idx === -1) return;
      const task = toggleAndRepositionTask(state.tasks, idx);
      if (!isTaskEmptyText(task.text)) {
        markTaskDirty(task);
        void (async () => {
          await persistTask(task);
        })();
      }
      schedulePersistTaskPositions();
      render();
    }

    function setTextAndMaybeResort(taskId, text) {
      const idx = getTaskIndex(taskId);
      if (idx === -1) return;
      // Keep typing path identical to normal tasks: plain text only.
      state.tasks[idx].text = text;
      markTaskDirty(state.tasks[idx]);
    }

    tasksEl.addEventListener(
      "pointerdown",
      (e) => {
        if (!isAuthed) return;
        suppressDayEmptyClickNewPlan = false;
        const row = e.target.closest?.(".task-row");
        if (row) return;
        if (!tasksEl.contains(e.target)) return;
        const ae = document.activeElement;
        if (ae && ae.classList?.contains("task-text") && tasksEl.contains(ae)) {
          suppressDayEmptyClickNewPlan = true;
        }
      },
      true
    );

    dayRect.addEventListener("click", (e) => {
      if (state.isDragging) return;
      if (!isAuthed) return;

      const row = e.target.closest(".task-row");
      const isCheckbox = e.target.classList && e.target.classList.contains("task-checkbox");
      const isCommit = e.target.classList && e.target.classList.contains("task-commit");
      const isDelete = e.target.classList && e.target.classList.contains("task-delete");
      const isText = e.target.classList && e.target.classList.contains("task-text");

      if (row) {
        const id = row.dataset.id;
        if (!id) return;

        if (isCheckbox) {
          toggleChecked(id);
          return;
        }

        const isColor = !!e.target.closest?.(".task-color");
        const isDragHandle =
          e.target.classList?.contains("task-drag-handle") ||
          e.target.classList?.contains("task-drag-handle-icon") ||
          !!e.target.closest?.(".task-drag-handle");

        if (isCommit || isDelete || isColor || isDragHandle) {
          return;
        }

        if (isText) {
          e.target.focus();
          return;
        }

        // Click on bar / main wrapper should still go to edit mode.
        const input = row.querySelector(".task-text");
        if (input) input.focus();
        return;
      }

      if (!tasksEl.contains(e.target)) return;
      if (suppressDayEmptyClickNewPlan) {
        suppressDayEmptyClickNewPlan = false;
        void flushAllTaskSaves();
        return;
      }
      beginNewPlanFromEmptyClick();
    });

    tasksEl.addEventListener("input", (e) => {
      if (!isAuthed) return;
      const input = e.target;
      if (!input.classList || !input.classList.contains("task-text")) return;

      const row = input.closest(".task-row");
      const id = row?.dataset.id;
      if (!id) return;

      setTextAndMaybeResort(id, input.value);
      autoSizeTextarea(input);
    });

    tasksEl.addEventListener("keydown", (e) => {
      if (!isAuthed) return;
      const input = e.target;
      if (!input.classList || !input.classList.contains("task-text")) return;

      const row = input.closest(".task-row");
      const id = row?.dataset.id;
      if (!id) return;

      const idx = getTaskIndex(id);
      if (idx === -1) return;

      if (e.key !== "Enter") return;
      if (e.shiftKey) return;

      e.preventDefault();

      void (async () => {
        const ok = await commitTask(id);
        if (!ok) return;
        // Enter only saves and leaves edit mode; do not open a new draft row (click empty area for that).
        const active = document.activeElement;
        if (active && active.classList?.contains("task-text") && tasksEl.contains(active)) {
          active.blur();
        }
      })();
    });

    async function flushFocusedDayInput() {
      const active = document.activeElement;
      if (!active || !active.classList || !active.classList.contains("task-text")) return;
      if (!tasksEl.contains(active)) return;
      const row = active.closest(".task-row");
      const id = row?.dataset.id;
      if (!id) return;
      await syncTaskFromInput(id);
    }

    async function flushDirtyDayTasks() {
      if (!isAuthed || !currentUserId) return;
      for (const t of state.tasks) {
        if (!t._dirty) continue;
        if (isTaskEmptyText(t.text) && !t.dbId) {
          t._dirty = false;
          continue;
        }
        await persistTask(t);
      }
    }

    registerTaskSaveFlush(async () => {
      await flushFocusedDayInput();
      await flushDirtyDayTasks();
    });

    // Same idea as the general panel: on reconnection, push then pull.
    onNetworkRetry(async () => {
      if (!isAuthed) return;
      await flushDirtyDayTasks();
      await loadTasksForDay();
    });

    tasksEl.addEventListener("dragover", (e) => {
      if (!isAuthed || !isActiveTaskDragEvent(e)) return;
      const list = tasksEl.querySelector(".tasks-list");
      if (!list) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const payload = readDragPayloadFromEvent(e);
      if (payload && payload.sourceBlock !== blockId) {
        const insertAt = computeCrossInsertIndex(
          state.tasks,
          getTaskIndex,
          e,
          list,
          !!payload.checked
        );
        showCrossDropIndicator(dayDropIndicator, list, insertAt);
        return;
      }
      updateTaskDropIndicator(tasksEl, dayDropIndicator, list, e, state.draggedId, getTaskIndex);
    });

    dayRect.addEventListener("dragleave", (e) => {
      const related = e.relatedTarget;
      if (related && dayRect.contains(related)) return;
      dayDropIndicator.hide();
    });

    tasksEl.addEventListener(
      "drop",
      async (e) => {
        if (!isAuthed) return;

        const payload = readDragPayloadFromEvent(e);
        if (!payload || payload.sourceBlock === blockId) return;

        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        const list = tasksEl.querySelector(".tasks-list");
        const insertAt = computeCrossInsertIndex(
          state.tasks,
          getTaskIndex,
          e,
          list,
          !!payload.checked
        );

        hideAllTaskDropIndicators();

        const textNorm = moveTimeToStart(payload.text);
        const checked = !!payload.checked;
        const sub = !!payload.subtask;
        const color = normalizeTaskColor(payload.color);
        const safeInsertAt = Math.max(0, Math.min(insertAt, state.tasks.length));

        window.dispatchEvent(
          new CustomEvent("task-cross-move", {
            detail: {
              sourceBlock: payload.sourceBlock,
              sourceLocalId: payload.localId,
              targetBlock: blockId,
            },
          })
        );

        const moved = createTask(textNorm, checked, payload.dbId || null, sub, color);
        state.tasks.splice(safeInsertAt, 0, moved);
        stabilizeTimeSorted();
        normalizeSubtaskFlags(state.tasks);
        schedulePersistTaskPositions();
        state.focusAfterRender = { id: moved.id };
        render();

        await flushAllTaskSaves();

        if (payload.dbId) {
          const { ok, error } = await supabaseRelocateTaskRow(supabase, currentUserId, payload.dbId, {
            type: "daily",
            day_name: dayMeta.dayName,
            date: dayMeta.date,
            content: String(textNorm),
            completed: checked,
            is_subtask: sub,
            color,
            workspace_id: getActiveWorkspaceId(),
            position: safeInsertAt,
          });
          if (!ok) {
            console.error("Supabase move-to-day failed:", error);
            return;
          }
        }

        if (!payload.dbId && !isTaskEmptyText(textNorm)) {
          markTaskDirty(moved);
          await persistTask(moved);
        }

        clearGlobalDragPayload();
        void flushAllTaskSaves();
      },
      true
    );

    async function setAuthUser(userId) {
      const nextUserId = userId || null;

      if (!nextUserId) {
        if (!isAuthed && !currentUserId) return;
        isAuthed = false;
        currentUserId = null;
        tasksWorkspaceId = null;
        state.tasks = [];
        tasksEl.innerHTML = "";
        return;
      }

      if (isAuthed && currentUserId === nextUserId) return;

      isAuthed = true;
      currentUserId = nextUserId;

      await awaitWorkspaceReady(userId);
      await loadTasksForDay();
    }

    window.addEventListener("task-cross-move", (e) => {
      const detail = e.detail || {};
      if (detail.sourceBlock !== blockId) return;
      if (detail.targetBlock === blockId) return;

      const idx = getTaskIndex(detail.sourceLocalId);
      if (idx === -1) return;
      state.tasks.splice(idx, 1);
      render();
    });

    window.addEventListener(WEEK_CHANGE_EVENT, async () => {
      dayMeta = getDayMeta(dayName);
      if (!isAuthed) return;
      await loadTasksForDay();
    });

    window.addEventListener("workspace-change", async () => {
      if (!isAuthed) return;
      await loadTasksForDay();
    });

    return { setAuthUser };
  }

  const controllers = Array.from(dayRects)
    .map((dayRect) => setupDay(dayRect))
    .filter(Boolean);

  async function applyAuthSession(session) {
    const userId = session?.user?.id || null;
    await Promise.all(controllers.map((c) => c.setAuthUser(userId)));
  }

  async function initDailyAuth() {
    if (!supabase) {
      console.error("Supabase client is not initialized for daily tasks.");
      return;
    }

    const { data } = await supabase.auth.getSession();
    await applyAuthSession(data?.session);

    supabase.auth.onAuthStateChange((_event, session) => {
      void applyAuthSession(session);
    });
  }

  void initDailyAuth();
})();

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

    const dayRects = document.querySelectorAll(".day-rect[data-day]");
    dayRects.forEach((rect) => {
      const dayName = rect.dataset.day;
      const dayIndex = weekdayToIndex[dayName];
      if (dayIndex == null) return; // skip "Next week"

      const date = new Date(weekStart);
      date.setDate(weekStart.getDate() + dayIndex);

      const label = rect.querySelector(".day-label");
      if (!label) return;
      label.textContent = `${dayName}, ${date.getDate()}`;
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
      if (typeof window.__flushAllTaskSaves === "function") {
        await window.__flushAllTaskSaves();
      }
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
      if (typeof window.__flushAllTaskSaves === "function") {
        await window.__flushAllTaskSaves();
      }
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

  const MONTH_NAMES = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];

  function formatWeekLabel(mondayDate) {
    const mon = new Date(mondayDate);
    const sun = new Date(mon);
    sun.setDate(sun.getDate() + 6);
    const d1 = mon.getDate();
    const m1 = MONTH_NAMES[mon.getMonth()];
    const d2 = sun.getDate();
    const m2 = MONTH_NAMES[sun.getMonth()];
    return `${d1}${m1} — ${d2}${m2}`;
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
      let name;
      if (offset === 0) name = `${dateLabel} (now)`;
      else if (offset === 1) name = `${dateLabel} (next week)`;
      else if (offset === -1) name = `${dateLabel} (last week)`;
      else name = dateLabel;
      li.textContent = name;
      if (offset === currentOffset) li.classList.add("week-active");
      li.addEventListener("click", () => setWeekOffset(offset));
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

async function signUp() {
  const supabase = window.supabaseClient;
  if (!supabase) {
    console.error("Supabase client missing.");
    return { ok: false, error: "Auth client not initialized." };
  }

  const email = document.getElementById("email").value;
  const password = document.getElementById("password").value;

  const { error } = await supabase.auth.signUp({
    email,
    password,
  });

  if (error) {
    return { ok: false, error: error.message || "Sign up failed." };
  }
  return { ok: true };
}

async function login() {
  const supabase = window.supabaseClient;
  if (!supabase) {
    console.error("Supabase client missing.");
    return { ok: false, error: "Auth client not initialized." };
  }

  const email = document.getElementById("email").value;
  const password = document.getElementById("password").value;

  const { error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    return { ok: false, error: error.message || "Login failed." };
  }
  return { ok: true };
}

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
    if (typeof window.__flushAllTaskSaves === "function") {
      await window.__flushAllTaskSaves();
    }
  } catch (err) {
    console.error("Pre-logout flush failed:", err);
  }

  const { error } = await supabase.auth.signOut();
  if (error) {
    console.error("Sign out failed:", error);
    return { ok: false, error: "Logout failed." };
  }
  return { ok: true };
}

window.addEventListener("load", () => {
  const overlay = document.getElementById("auth-overlay");
  const authTriggers = document.querySelectorAll("#auth-trigger, #auth-trigger-mobile");
  const closeBtn = document.getElementById("auth-close");
  const signupBtn = document.getElementById("auth-signup");
  const loginBtn = document.getElementById("auth-login");
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
    if (signupBtn) signupBtn.disabled = isPending;
    if (loginBtn) loginBtn.disabled = isPending;
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

  if (window.supabaseClient) {
    window.supabaseClient.auth.onAuthStateChange(() => {
      void refreshAuthStatus();
    });
    void refreshAuthStatus();
  }

  const themeInputText = document.getElementById("theme-color-text");
  const themeInputBg = document.getElementById("theme-color-background");
  const themeFontSelect = document.getElementById("theme-font");
  const themeApplyBtn = document.getElementById("theme-apply");
  const themeSelect = document.getElementById("theme-select");
  const themeCustomFields = document.getElementById("theme-custom-fields");
  const themeDeleteBtn = document.getElementById("theme-delete");
  const themeCustomName = document.getElementById("theme-custom-name");

  let editingCustomThemeId = null;

  function getThemePresets() {
    return themeApi()?.PRESETS || {};
  }

  function themeApi() {
    return window.oneweekTheme;
  }

  function getSelectedThemeKey() {
    const tw = themeApi();
    const storageKey = tw?.THEME_SELECTED_KEY || "oneweek-theme-selected";
    try {
      const raw = localStorage.getItem(storageKey) || "white";
      const tw = themeApi();
      return tw?.migrateThemeKey?.(raw) ?? raw;
    } catch (_) {
      return "white";
    }
  }

  function setSelectedThemeKey(key) {
    const tw = themeApi();
    const storageKey = tw?.THEME_SELECTED_KEY || "oneweek-theme-selected";
    try {
      localStorage.setItem(storageKey, key);
    } catch (_) {}
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
    if (tw.isCustomThemeKey(key)) {
      const theme = tw.findCustomTheme(tw.customThemeIdFromKey(key));
      if (theme) {
        tw.persistTheme(theme.text, theme.bg);
        tw.applyThemeToDocument(theme.text, theme.bg, theme.fontId || "");
      }
    } else {
      const p = getThemePresets()[key];
      if (p) {
        tw.persistTheme(p.text, p.bg);
        tw.applyThemeToDocument(p.text, p.bg, "");
      }
    }
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
    let resolvedKey = previousKey;
    if (resolvedKey === "custom") {
      const themes = tw.getCustomThemes();
      if (themes.length > 0) {
        const pick = themes.find((t) => t.id === "migrated") || themes[0];
        resolvedKey = tw.customThemeSelectKey(pick.id);
      }
    }
    if (tw.isCustomThemeKey(resolvedKey)) {
      const id = tw.customThemeIdFromKey(resolvedKey);
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
    const tw = themeApi();
    key = tw?.migrateThemeKey?.(key) ?? key;
    if (key === "own") return "own";
    if (getThemePresets()[key]) return key;
    if (tw && key === "custom") {
      const themes = tw.getCustomThemes();
      if (themes.length > 0) {
        const pick = themes.find((t) => t.id === "migrated") || themes[0];
        return tw.customThemeSelectKey(pick.id);
      }
    }
    if (tw && tw.isCustomThemeKey(key)) {
      const theme = tw.findCustomTheme(tw.customThemeIdFromKey(key));
      if (theme) return key;
    }
    return "white";
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
      key = "white";
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

  function openAuthPopup() {
    if (!overlay || !sidebar) return;
    overlay.hidden = false;
    sidebar.hidden = false;
    setAuthMessage("");
    syncThemeSelect();
    void refreshAuthStatus();
  }

  window.oneweekOpenAuth = openAuthPopup;

  function closeAuthPopup() {
    if (!overlay || !sidebar) return;
    overlay.hidden = true;
    sidebar.hidden = true;
  }

  authTriggers.forEach((btn) => {
    if (btn) btn.addEventListener("click", openAuthPopup);
  });
  if (closeBtn) closeBtn.addEventListener("click", closeAuthPopup);

  if (overlay) {
    overlay.addEventListener("click", closeAuthPopup);
  }

  if (signupBtn) {
    signupBtn.addEventListener("click", async () => {
      await runAuthAction(
        "Signing up...",
        signUp,
        "Sign up successful. Check your email for confirmation."
      );
    });
  }

  if (loginBtn) {
    loginBtn.addEventListener("click", async () => {
      await runAuthAction("Logging in...", login, "Logged in.");
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
      tw.persistTheme(nt, nb);
      tw.applyThemeToDocument(nt, nb, fontId);
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
      applyThemeByKey("white");
      syncThemeSelect();
      setAuthMessage("Custom theme deleted.", false);
    });
  }

  buildThemeFontOptions();
  syncThemeSelect();
});

/**
 * Mobile-only: position the .task-row-actions popover as position:fixed so it can
 * escape the .day-tasks / .week-grid overflow clips. The CSS sets position:fixed
 * on mobile; this code computes top/left/width from the active task row's rect
 * and updates on focus, scroll, resize, and class mutations.
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
    ".task-row:has(.task-drag-handle:focus)",
    ".task-row.task-row-reorder-active",
    ".task-row.task-row-color-open",
  ].join(", ");

  function isMobile() {
    return MOBILE_MEDIA ? MOBILE_MEDIA.matches : false;
  }

  function clearAllPanels() {
    document.querySelectorAll(".task-row-actions").forEach((panel) => {
      panel.style.top = "";
      panel.style.left = "";
      panel.style.width = "";
    });
  }

  function update() {
    if (!isMobile()) {
      clearAllPanels();
      return;
    }
    const row = document.querySelector(ACTIVE_ROW_SELECTOR);
    if (!row) {
      clearAllPanels();
      return;
    }
    const panel = row.querySelector(":scope > .task-row-actions");
    if (!panel) return;
    const rect = row.getBoundingClientRect();
    panel.style.left = `${rect.left}px`;
    panel.style.width = `${rect.width}px`;
    // Completed rows live at the bottom of the tasks field — drop the popover
    // above the row instead of below so it doesn't fall off the screen.
    if (row.classList.contains("completed")) {
      const panelHeight = panel.getBoundingClientRect().height;
      panel.style.top = `${rect.top - panelHeight - 6}px`;
    } else {
      panel.style.top = `${rect.bottom + 6}px`;
    }
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
  window.addEventListener("resize", scheduleUpdate);
  window.addEventListener("scroll", scheduleUpdate, true);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", scheduleUpdate);
    window.visualViewport.addEventListener("scroll", scheduleUpdate);
  }
  if (MOBILE_MEDIA && MOBILE_MEDIA.addEventListener) {
    MOBILE_MEDIA.addEventListener("change", scheduleUpdate);
  }

  // Catch class-driven state changes (color picker open, reorder active).
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
 * Supabase session. One submit button does both login and signup:
 *
 *   1. Try sign-in. If it succeeds, the auth state change closes the modal.
 *   2. If sign-in fails with "invalid credentials" / "user not found" /
 *      "email not confirmed", try sign-up. On success, show the
 *      "confirm your email" message.
 *   3. Other errors surface as red text under the form.
 */
(function setupGuestAuthModal() {
  const backdrop = document.getElementById("guest-auth-backdrop");
  const form = document.getElementById("guest-auth-form");
  const emailInput = document.getElementById("guest-auth-email");
  const passwordInput = document.getElementById("guest-auth-password");
  const submitBtn = document.getElementById("guest-auth-submit");
  const messageEl = document.getElementById("guest-auth-message");
  const messageSlot = document.getElementById("guest-auth-message-slot");
  if (!backdrop || !form || !emailInput || !passwordInput || !submitBtn) return;

  const supabase = window.supabaseClient;
  if (!supabase) return;

  function setMessage(text, isError = false) {
    if (!messageEl) return;
    messageEl.textContent = text || "";
    messageEl.classList.toggle("is-error", !!isError && !!text);
    // The slot animates open/closed via CSS (`grid-template-rows`). We keep
    // the text in the DOM (instead of using `hidden`) so the modal smoothly
    // grows when a new message comes in instead of snapping.
    if (messageSlot) messageSlot.classList.toggle("is-shown", !!text);
  }

  function setPending(isPending) {
    submitBtn.disabled = isPending;
    emailInput.disabled = isPending;
    passwordInput.disabled = isPending;
    submitBtn.textContent = isPending ? "..." : "Sign in / Sign up";
  }

  function show() {
    if (!backdrop.hidden) return;
    backdrop.hidden = false;
    // Give the browser a tick to mount, then focus the email field.
    requestAnimationFrame(() => emailInput.focus({ preventScroll: true }));
  }

  function hide() {
    if (backdrop.hidden) return;
    backdrop.hidden = true;
    setMessage("");
    setPending(false);
    form.reset();
  }

  /** Did sign-in fail specifically because no account exists with this email
   *  (or wrong password — Supabase intentionally collapses both into the same
   *  message to prevent user enumeration)? In either case it's safe to try a
   *  sign-up: if the account already exists, the sign-up will report it. */
  function looksLikeMissingAccount(error) {
    const msg = String(error?.message || error || "").toLowerCase();
    return (
      msg.includes("invalid login") ||
      msg.includes("invalid credentials") ||
      msg.includes("user not found")
    );
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

  async function handleSubmit(e) {
    e.preventDefault();
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !password) {
      setMessage("Enter your email and password.", true);
      return;
    }

    setPending(true);
    setMessage("Signing in...");

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (!signInError) {
      // onAuthStateChange will hide the modal.
      setMessage("");
      setPending(false);
      return;
    }

    // Account exists but the user hasn't clicked the confirmation link yet —
    // re-send the email (best-effort) and surface a clear message.
    if (looksLikeUnconfirmedEmail(signInError)) {
      try {
        await supabase.auth.resend({ type: "signup", email });
      } catch (_) {
        /* best-effort resend — original message still tells the user what to do */
      }
      setPending(false);
      showConfirmEmailMessage(email);
      return;
    }

    if (!looksLikeMissingAccount(signInError)) {
      setPending(false);
      setMessage(signInError.message || "Couldn't sign in.", true);
      return;
    }

    // Either no such account, or correct email + wrong password. Try sign-up:
    // if Supabase responds "already registered", we know it was the password.
    setMessage("Creating account...");
    const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
    });

    setPending(false);

    if (signUpError) {
      const msg = String(signUpError.message || "").toLowerCase();
      if (msg.includes("already registered") || msg.includes("already been registered")) {
        setMessage("Wrong password for this email.", true);
      } else {
        setMessage(signUpError.message || "Couldn't create account.", true);
      }
      return;
    }

    // With email confirmation OFF, Supabase returns a session immediately and
    // onAuthStateChange closes the modal. With confirmation ON (the current
    // setup), there's no session yet — tell the user to check their inbox.
    if (signUpData?.session) {
      setMessage("");
      return;
    }
    showConfirmEmailMessage(email);
  }

  form.addEventListener("submit", handleSubmit);

  async function applySession(session) {
    if (session?.user) hide();
    else show();
  }

  (async () => {
    try {
      const { data } = await supabase.auth.getSession();
      await applySession(data?.session ?? null);
    } catch (err) {
      console.error("Guest auth init failed:", err);
      show();
    }
  })();

  supabase.auth.onAuthStateChange((_event, session) => {
    void applySession(session);
  });
})();
