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

if (typeof window !== "undefined") {
  window.__weekOffset = Number(window.__weekOffset || 0);
}

const WEEK_CHANGE_EVENT = "week-offset-change";

function createPersistTask(insertOrUpdateTaskInDb, logPrefix = "Supabase persist failed:") {
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
    };
    const next = (tail ?? Promise.resolve())
      .then(() => insertOrUpdateTaskInDb(task, snapshot))
      .catch((err) => {
        console.error(logPrefix, err);
      });
    pendingPersist.set(key, next);
    try {
      await next;
    } finally {
      if (pendingPersist.get(key) === next) {
        pendingPersist.delete(key);
      }
      if (task) task._dirty = false;
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

/**
 * One Supabase write for cross-panel moves (type + day + content in one request).
 * Do not require `.select()` after update: RLS often allows UPDATE but not returning rows,
 * which yields empty `data` with no `error` — that previously blocked the UI incorrectly.
 */
async function supabaseRelocateTaskRow(supabase, userId, rowId, fields) {
  if (!supabase || !userId || rowId == null) {
    return { ok: false, error: new Error("supabaseRelocateTaskRow: missing client, user, or row id") };
  }
  const { error } = await supabase
    .from("tasks")
    .update({
      type: fields.type,
      day_name: fields.day_name ?? null,
      date: fields.date,
      content: String(fields.content ?? ""),
      completed: !!fields.completed,
      is_subtask: !!fields.is_subtask,
    })
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

/** Unchecked first, then completed — stable order inside each group. */
function partitionUncheckedBeforeChecked(tasks) {
  const unchecked = tasks.filter((t) => !t.checked);
  const checked = tasks.filter((t) => t.checked);
  return [...unchecked, ...checked];
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

/** Toggle task completion and keep unchecked tasks above completed tasks. */
function toggleAndRepositionTask(tasks, idx) {
  const task = tasks[idx];
  task.checked = !task.checked;
  tasks.splice(idx, 1);
  if (task.checked) {
    tasks.push(task);
  } else {
    const fc = firstCheckedTaskIndex(tasks);
    const insertIndex = fc === -1 ? tasks.length : fc;
    tasks.splice(insertIndex, 0, task);
  }
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
  /** Empty-area click right after editing: save only, do not open a new draft row. */
  let suppressGeneralEmptyClickNewTask = false;

  function createTask(text = "", checked = false, dbId = null, subtask = false) {
    const id = `task-${state.nextId++}`;
    return { id, dbId, text, checked, subtask: !!subtask, _dirty: false };
  }

  function buildDragPayload(task) {
    return {
      sourceBlock: GENERAL_BLOCK_ID,
      localId: task.id,
      dbId: task.dbId ?? null,
      text: task.text ?? "",
      checked: !!task.checked,
      subtask: !!task.subtask,
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

  function autoSizeTextarea(el) {
    if (!el) return;
    el.style.height = "auto";
    const safeHeight = Math.max(el.scrollHeight || 0, 18);
    el.style.height = `${safeHeight}px`;
  }

  function setTasksInteractivity(enabled) {
    tasksField.style.pointerEvents = enabled ? "auto" : "none";
    tasksFieldRoot.style.pointerEvents = enabled ? "auto" : "none";
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

    if (error) console.error("Supabase delete failed:", error);
    task.dbId = null;
  }

  async function insertOrUpdateTaskInDb(task, snapshot) {
    if (!isAuthed || !authUserId) return;
    if (!task) return;

    const source = snapshot || task;
    const content = String(source.text ?? "");
    const completed = !!source.checked;
    const isSubtask = !!source.subtask;
    const dbId = source.dbId ?? task.dbId ?? null;

    if (isTaskEmptyText(content)) {
      await deleteTaskFromDb(task);
      return;
    }

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
        })
        .eq("id", dbId)
        .eq("user_id", authUserId);

      if (error) console.error("Supabase update failed:", error);
      return;
    }

    const { data, error } = await supabase
      .from("tasks")
      .insert({
        user_id: authUserId,
        content,
        completed,
        type: "general",
        date: getVisibleWeekMondayIso(),
        is_subtask: isSubtask,
      })
      .select("id")
      .single();

    if (error) {
      console.error("Supabase insert failed:", error);
      return;
    }

    task.dbId = data?.id ?? null;
  }

  const persistTask = createPersistTask(insertOrUpdateTaskInDb, "Supabase persist failed:");

  async function loadTasksForUser() {
    if (!supabase) {
      console.error("Supabase client is not initialized.");
      return;
    }
    if (!authUserId) return;

    const requestedWeekIso = getVisibleWeekMondayIso();

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

    const { data, error } = await supabase
      .from("tasks")
      .select("id, content, completed, created_at, is_subtask")
      .eq("user_id", authUserId)
      .eq("type", "general")
      .eq("date", requestedWeekIso)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("Supabase load failed:", error);
      return;
    }

    if (getVisibleWeekMondayIso() !== requestedWeekIso) return;

    state.tasks = (data ?? []).map((row) => ({
      id: `task-${state.nextId++}`,
      dbId: row.id,
      text: row.content ?? "",
      checked: !!row.completed,
      subtask: !!row.is_subtask,
    }));
    normalizeSubtaskFlags(state.tasks);
    state.tasks = partitionUncheckedBeforeChecked(state.tasks);

    if (state.tasks.length === 0) {
      state.tasks = [createTask("", false, null)];
    }
  }

  async function handleSession(session) {
    const hasUser = !!session?.user;
    isAuthed = hasUser;
    authUserId = session?.user?.id ?? null;

    setTasksInteractivity(hasUser);

    if (!hasUser) {
      state.tasks = [];
      tasksFieldRoot.innerHTML = "";
      return;
    }

    await loadTasksForUser();
    render();
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
    if (task.dbId) void deleteTaskFromDb(task);
    state.focusAfterRender = null;
    state.tasks.splice(idx, 1);
    if (state.tasks.length === 0) state.tasks = [createTask("", false, null)];
    render();
  }

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
      if (task.dbId) void deleteTaskFromDb(task);
      state.focusAfterRender = null;
      state.tasks.splice(idx, 1);
      if (state.tasks.length === 0) state.tasks = [createTask("", false, null)];
      return { needRender: true };
    }
    // Do not await: UI would freeze for one network round-trip per blur/commit.
    void persistTask(task);
    return { needRender: false };
  }

  async function commitTask(taskId) {
    const { needRender } = await syncTaskFromInput(taskId);
    state.tasks = partitionUncheckedBeforeChecked(state.tasks);
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

  function render() {
    tasksFieldRoot.innerHTML = "";

    const list = document.createElement("div");
    list.className = "tasks-list";

    for (const task of state.tasks) {
      const taskId = task.id;
      const row = document.createElement("div");
      row.className = `task-row${task.checked ? " completed" : ""}${
        task.subtask ? " task-row-sub" : ""
      }`;
      row.dataset.id = taskId;
      row.draggable = isAuthed;

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

      const commitBtn = document.createElement("button");
      commitBtn.type = "button";
      commitBtn.className = "task-commit";
      commitBtn.setAttribute("aria-label", "Done");

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "task-delete";
      deleteBtn.setAttribute("aria-label", "Delete task");

      row.appendChild(checkbox);
      row.appendChild(input);
      row.appendChild(commitBtn);
      row.appendChild(deleteBtn);
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
          state.focusAfterRender = {
            id: task.id,
            start: e.target.selectionStart,
            end: e.target.selectionEnd,
          };
          render();
        },
        true
      );

      row.addEventListener("dragstart", (e) => {
        if (!isAuthed) return;
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
      });

      row.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      });

      row.addEventListener("drop", (e) => {
        e.preventDefault();
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

        const [moved] = state.tasks.splice(from, 1);
        const adjustedTo = from < to ? to - 1 : to;
        state.tasks.splice(adjustedTo, 0, moved);

        normalizeSubtaskFlags(state.tasks);
        if (moved.dbId && !isTaskEmptyText(moved.text)) {
          markTaskDirty(moved);
          void (async () => {
            await persistTask(moved);
          })();
        }

        state.focusAfterRender = { id: moved.id };
        render();
      });

      row.addEventListener("dragend", () => {
        state.isDragging = false;
        state.draggedId = null;
        clearGlobalDragPayload();
      });

      input.addEventListener("blur", () => {
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
    const task = state.tasks[idx];
    task.checked = !task.checked;

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
    const isText = e.target.classList.contains("task-text");
    if (!isCheckbox && !isText && !isCommit && !isDelete) return;
    if (isCommit || isDelete) return;

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
    if (!isAuthed) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
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

      await flushAllTaskSaves();

      const text = String(payload.text ?? "");
      const checked = !!payload.checked;
      const sub = !!payload.subtask;

      if (payload.dbId) {
        const { ok, error } = await supabaseRelocateTaskRow(supabase, authUserId, payload.dbId, {
          type: "general",
          day_name: null,
          date: getVisibleWeekMondayIso(),
          content: text,
          completed: checked,
          is_subtask: sub,
        });
        if (!ok) {
          console.error("Supabase move-to-general failed:", error);
          return;
        }
      }

      const moved = createTask(text, checked, payload.dbId || null, sub);
      if (moved.checked) {
        state.tasks.push(moved);
      } else {
        const fc = firstCheckedTaskIndex(state.tasks);
        if (fc === -1) state.tasks.push(moved);
        else state.tasks.splice(fc, 0, moved);
      }
      state.focusAfterRender = { id: moved.id };
      render();

      if (!payload.dbId && !isTaskEmptyText(text)) {
        markTaskDirty(moved);
        await persistTask(moved);
      }

      window.dispatchEvent(
        new CustomEvent("task-cross-move", {
          detail: {
            sourceBlock: payload.sourceBlock,
            sourceLocalId: payload.localId,
            targetBlock: GENERAL_BLOCK_ID,
          },
        })
      );

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
    if (state.tasks.length === 0) state.tasks = [createTask("", false, null)];
    render();
  });

  window.addEventListener(WEEK_CHANGE_EVENT, () => {
    if (!isAuthed || !authUserId) return;
    void (async () => {
      await loadTasksForUser();
      render();
    })();
  });

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
    /** Empty-area click while a task field was focused: save only, no new draft. */
    let suppressDayEmptyClickNewPlan = false;

    function createTask(text = "", checked = false, dbId = null, subtask = false) {
      const id = `d-${daySlugForId}-${state.nextId++}`;
      return { id, dbId, text, checked, subtask: !!subtask, _dirty: false };
    }

    function buildDragPayload(task) {
      return {
        sourceBlock: blockId,
        localId: task.id,
        dbId: task.dbId ?? null,
        text: task.text ?? "",
        checked: !!task.checked,
        subtask: !!task.subtask,
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

    function autoSizeTextarea(el) {
      if (!el) return;
      el.style.height = "auto";
      const safeHeight = Math.max(el.scrollHeight || 0, 18);
      el.style.height = `${safeHeight}px`;
    }

    async function deleteTaskFromDb(task) {
      if (!supabase || !isAuthed || !currentUserId || !task?.dbId) return;

      const { error } = await supabase
        .from("tasks")
        .delete()
        .eq("id", task.dbId)
        .eq("user_id", currentUserId);

      if (error) console.error("Supabase daily delete failed:", error);
      task.dbId = null;
    }

    async function insertOrUpdateTaskInDb(task, snapshot) {
      if (!supabase || !isAuthed || !currentUserId || !task) return;
      const source = snapshot || task;
      const content = String(source.text ?? "");
      const completed = !!source.checked;
      const isSubtask = !!source.subtask;
      const dbId = source.dbId ?? task.dbId ?? null;

      if (isTaskEmptyText(content)) {
        await deleteTaskFromDb(task);
        return;
      }

      if (dbId) {
        const { error } = await supabase
          .from("tasks")
          .update({ content, completed, is_subtask: isSubtask })
          .eq("id", dbId)
          .eq("user_id", currentUserId);

        if (error) console.error("Supabase daily update failed:", error);
        return;
      }

      const { data, error } = await supabase
        .from("tasks")
        .insert({
          user_id: currentUserId,
          content,
          completed,
          type: "daily",
          day_name: dayMeta.dayName,
          date: dayMeta.date,
          is_subtask: isSubtask,
        })
        .select("id")
        .single();

      if (error) {
        console.error("Supabase daily insert failed:", error);
        return;
      }

      task.dbId = data?.id ?? null;
    }

    const persistTask = createPersistTask(
      insertOrUpdateTaskInDb,
      "Supabase daily persist failed:"
    );

    async function loadTasksForDay() {
      if (!supabase || !isAuthed || !currentUserId) return;

      const { data, error } = await supabase
        .from("tasks")
        .select("id, content, completed, created_at, is_subtask")
        .eq("user_id", currentUserId)
        .eq("type", "daily")
        .eq("day_name", dayMeta.dayName)
        .eq("date", dayMeta.date)
        .order("created_at", { ascending: true });

      if (error) {
        console.error("Supabase daily load failed:", error);
        return;
      }

      state.tasks = (data ?? []).map((row) => ({
        id: `d-${daySlugForId}-${state.nextId++}`,
        dbId: row.id,
        text: moveTimeToStart(row.content ?? ""),
        checked: !!row.completed,
        subtask: !!row.is_subtask,
      }));
      state.tasks = partitionUncheckedBeforeChecked(state.tasks);
      normalizeSubtaskFlags(state.tasks);
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
      if (task.dbId) void deleteTaskFromDb(task);
      state.focusAfterRender = null;
      state.tasks.splice(idx, 1);
      stabilizeTimeSorted();
      render();
    }

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
        if (task.dbId) void deleteTaskFromDb(task);
        state.focusAfterRender = null;
        state.tasks.splice(idx, 1);
        stabilizeTimeSorted();
        return { needRender: true };
      }
      // Time-tasks differ only by ordering: sort timed tasks among themselves on commit.
      stabilizeTimeSorted();
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
      tasksEl.innerHTML = "";

      const list = document.createElement("div");
      list.className = "tasks-list";

      for (const task of state.tasks) {
        const taskId = task.id;

        const row = document.createElement("div");
        row.className = `task-row${task.checked ? " completed" : ""}${
          task.subtask ? " task-row-sub" : ""
        }`;
        row.dataset.id = taskId;
        row.draggable = isAuthed;

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

        const main = document.createElement("div");
        main.className = "task-main";
        main.appendChild(input);

        const commitBtn = document.createElement("button");
        commitBtn.type = "button";
        commitBtn.className = "task-commit";
        commitBtn.setAttribute("aria-label", "Done");

        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "task-delete";
        deleteBtn.setAttribute("aria-label", "Delete task");

        const actions = document.createElement("div");
        actions.className = "task-row-actions";
        actions.appendChild(commitBtn);
        actions.appendChild(deleteBtn);

        main.appendChild(actions);
        row.appendChild(checkbox);
        row.appendChild(main);
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
            state.focusAfterRender = {
              id: task.id,
              start: e.target.selectionStart,
              end: e.target.selectionEnd,
            };
            render();
          },
          true
        );

        row.addEventListener("dragstart", (e) => {
          if (!isAuthed) return;
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
        });

        row.addEventListener("dragover", (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        });

        row.addEventListener("drop", (e) => {
          e.preventDefault();
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

          const [moved] = state.tasks.splice(from, 1);
          const adjustedTo = from < to ? to - 1 : to;
          state.tasks.splice(adjustedTo, 0, moved);

          stabilizeTimeSorted();
          normalizeSubtaskFlags(state.tasks);
          if (moved.dbId && !isTaskEmptyText(moved.text)) {
            markTaskDirty(moved);
            void (async () => {
              await persistTask(moved);
            })();
          }

          state.focusAfterRender = { id: moved.id };
          render();
        });

        row.addEventListener("dragend", () => {
          state.isDragging = false;
          state.draggedId = null;
          clearGlobalDragPayload();
        });

        input.addEventListener("blur", () => {
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
      const task = state.tasks[idx];
      task.checked = !task.checked;
      if (!isTaskEmptyText(task.text)) {
        markTaskDirty(task);
        void (async () => {
          await persistTask(task);
        })();
      }
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

        if (isCommit || isDelete) {
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

    tasksEl.addEventListener("dragover", (e) => {
      if (!isAuthed) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
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

        await flushAllTaskSaves();

        const textNorm = moveTimeToStart(payload.text);
        const checked = !!payload.checked;
        const sub = !!payload.subtask;

        if (payload.dbId) {
          const { ok, error } = await supabaseRelocateTaskRow(supabase, currentUserId, payload.dbId, {
            type: "daily",
            day_name: dayMeta.dayName,
            date: dayMeta.date,
            content: String(textNorm),
            completed: checked,
            is_subtask: sub,
          });
          if (!ok) {
            console.error("Supabase move-to-day failed:", error);
            return;
          }
        }

        const moved = createTask(textNorm, checked, payload.dbId || null, sub);
        if (moved.checked) {
          state.tasks.push(moved);
        } else {
          const fc = firstCheckedTaskIndex(state.tasks);
          if (fc === -1) state.tasks.push(moved);
          else state.tasks.splice(fc, 0, moved);
        }
        stabilizeTimeSorted();
        normalizeSubtaskFlags(state.tasks);
        state.focusAfterRender = { id: moved.id };
        render();

        if (!payload.dbId && !isTaskEmptyText(textNorm)) {
          markTaskDirty(moved);
          await persistTask(moved);
        }

        window.dispatchEvent(
          new CustomEvent("task-cross-move", {
            detail: {
              sourceBlock: payload.sourceBlock,
              sourceLocalId: payload.localId,
              targetBlock: blockId,
            },
          })
        );

        clearGlobalDragPayload();
        void flushAllTaskSaves();
      },
      true
    );

    async function setAuthUser(userId) {
      isAuthed = !!userId;
      currentUserId = userId || null;

      if (!isAuthed) {
        state.tasks = [];
        tasksEl.innerHTML = "";
        return;
      }

      await loadTasksForDay();
      stabilizeTimeSorted();
      render();
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
      stabilizeTimeSorted();
      render();
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

  function shiftWeek(delta) {
    void (async () => {
      if (typeof window.__flushAllTaskSaves === "function") {
        await window.__flushAllTaskSaves();
      }
      window.__weekOffset = Number(window.__weekOffset || 0) + delta;
      syncWeekAwayClass();
      updateDayOfMonthLabels();
      renderWeeksList();
      window.dispatchEvent(new CustomEvent(WEEK_CHANGE_EVENT));
    })();
  }

  function setWeekOffset(offset) {
    void (async () => {
      if (typeof window.__flushAllTaskSaves === "function") {
        await window.__flushAllTaskSaves();
      }
      window.__weekOffset = offset;
      syncWeekAwayClass();
      updateDayOfMonthLabels();
      renderWeeksList();
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
      if (offset === 0) name = "now";
      else if (offset === 1) name = "next week";
      else if (offset === -1) name = "last week";
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

  syncWeekAwayClass();
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
  const themeApplyBtn = document.getElementById("theme-apply");
  const themeSelect = document.getElementById("theme-select");
  const themeCustomFields = document.getElementById("theme-custom-fields");
  const themeDeleteBtn = document.getElementById("theme-delete");

  const THEME_PRESETS = {
    light: { text: "#000000", bg: "#ffffff", label: "Light" },
    dark: { text: "#ffffff", bg: "#000000", label: "Dark" },
  };
  const THEME_SELECTED_KEY = "oneweek-theme-selected";
  const THEME_CUSTOM_TEXT_KEY = "oneweek-custom-text";
  const THEME_CUSTOM_BG_KEY = "oneweek-custom-bg";
  const THEME_CUSTOM_NAME_KEY = "oneweek-custom-name";

  function getCustomTheme() {
    try {
      const t = localStorage.getItem(THEME_CUSTOM_TEXT_KEY);
      const b = localStorage.getItem(THEME_CUSTOM_BG_KEY);
      const name = localStorage.getItem(THEME_CUSTOM_NAME_KEY) || "";
      if (t && b) return { text: t, bg: b, name };
    } catch (_) {}
    return null;
  }

  function buildThemeOptions() {
    if (!themeSelect) return;
    themeSelect.innerHTML = "";
    for (const [key, preset] of Object.entries(THEME_PRESETS)) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = preset.label;
      themeSelect.appendChild(opt);
    }
    const custom = getCustomTheme();
    if (custom) {
      const opt = document.createElement("option");
      opt.value = "custom";
      opt.textContent = custom.name || `Custom (${custom.text} / ${custom.bg})`;
      themeSelect.appendChild(opt);
    }
    const ownOpt = document.createElement("option");
    ownOpt.value = "own";
    ownOpt.textContent = "Own...";
    themeSelect.appendChild(ownOpt);
  }

  function getSelectedThemeKey() {
    try { return localStorage.getItem(THEME_SELECTED_KEY) || "light"; } catch (_) { return "light"; }
  }

  function applyThemeByKey(key) {
    const tw = window.oneweekTheme;
    if (!tw) return;
    if (key === "custom") {
      const custom = getCustomTheme();
      if (custom) {
        tw.persistTheme(custom.text, custom.bg);
        tw.applyThemeToDocument(custom.text, custom.bg);
      }
    } else if (THEME_PRESETS[key]) {
      const p = THEME_PRESETS[key];
      tw.persistTheme(p.text, p.bg);
      tw.applyThemeToDocument(p.text, p.bg);
    }
    try { localStorage.setItem(THEME_SELECTED_KEY, key); } catch (_) {}
  }

  function syncThemeInputs() {
    const tw = window.oneweekTheme;
    if (!tw || !themeInputText || !themeInputBg) return;
    themeInputText.value = tw.getCurrentHexForInput("--color-text", tw.THEME_STORAGE_TEXT, tw.DEFAULT_TEXT);
    themeInputBg.value = tw.getCurrentHexForInput("--color-background", tw.THEME_STORAGE_BG, tw.DEFAULT_BG);
  }

  function syncThemeSelect() {
    if (!themeSelect) return;
    const key = getSelectedThemeKey();
    buildThemeOptions();
    themeSelect.value = key;
    if (themeCustomFields) themeCustomFields.hidden = (key !== "own");
    if (themeDeleteBtn) themeDeleteBtn.hidden = (key !== "custom");
    syncThemeInputs();
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
        if (themeDeleteBtn) themeDeleteBtn.hidden = true;
        syncThemeInputs();
        try { localStorage.setItem(THEME_SELECTED_KEY, "own"); } catch (_) {}
        return;
      }
      if (themeCustomFields) themeCustomFields.hidden = true;
      if (themeDeleteBtn) themeDeleteBtn.hidden = (key !== "custom");
      applyThemeByKey(key);
    });
  }

  const themeCustomName = document.getElementById("theme-custom-name");

  function previewCustomTheme() {
    const tw = window.oneweekTheme;
    if (!tw || !themeInputText || !themeInputBg) return;
    const nt = tw.normalizeHexColor(themeInputText.value);
    const nb = tw.normalizeHexColor(themeInputBg.value);
    if (nt && nb) {
      tw.applyThemeToDocument(nt, nb);
    }
  }

  if (themeInputText) themeInputText.addEventListener("input", previewCustomTheme);
  if (themeInputBg) themeInputBg.addEventListener("input", previewCustomTheme);

  if (themeApplyBtn) {
    themeApplyBtn.addEventListener("click", () => {
      const tw = window.oneweekTheme;
      if (!tw || !themeInputText || !themeInputBg) return;
      const nt = tw.normalizeHexColor(themeInputText.value);
      const nb = tw.normalizeHexColor(themeInputBg.value);
      if (!nt || !nb) {
        setAuthMessage("Please enter colors in #RGB or #RRGGBB format.", true);
        return;
      }
      const name = (themeCustomName ? themeCustomName.value.trim() : "") || "";
      try {
        localStorage.setItem(THEME_CUSTOM_TEXT_KEY, nt);
        localStorage.setItem(THEME_CUSTOM_BG_KEY, nb);
        localStorage.setItem(THEME_CUSTOM_NAME_KEY, name);
        localStorage.setItem(THEME_SELECTED_KEY, "custom");
      } catch (_) {}
      tw.persistTheme(nt, nb);
      tw.applyThemeToDocument(nt, nb);
      buildThemeOptions();
      themeSelect.value = "custom";
      if (themeCustomFields) themeCustomFields.hidden = true;
      setAuthMessage("Custom theme saved.", false);
    });
  }

  if (themeDeleteBtn) {
    themeDeleteBtn.addEventListener("click", () => {
      try {
        localStorage.removeItem(THEME_CUSTOM_TEXT_KEY);
        localStorage.removeItem(THEME_CUSTOM_BG_KEY);
        localStorage.removeItem(THEME_CUSTOM_NAME_KEY);
      } catch (_) {}
      applyThemeByKey("light");
      syncThemeSelect();
    });
  }

  syncThemeSelect();
});

