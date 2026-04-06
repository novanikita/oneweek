/** Monday 00:00 of the week currently shown (week arrows / __weekOffset). */
function getVisibleWeekStartDate() {
  const now = new Date();
  const todayDow = now.getDay();
  const mondayOffset = (todayDow + 6) % 7;
  const weekStart = new Date(now);
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(now.getDate() - mondayOffset + Number(window.__weekOffset || 0) * 7);
  return weekStart;
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

/** Real “this week” Monday — for one-time migration of legacy rows without `date`. */
function getCalendarWeekMondayIso() {
  const now = new Date();
  const todayDow = now.getDay();
  const mondayOffset = (todayDow + 6) % 7;
  const weekStart = new Date(now);
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(now.getDate() - mondayOffset);
  return toIsoDateFromDate(weekStart);
}

if (typeof window !== "undefined") {
  window.__weekOffset = Number(window.__weekOffset || 0);
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

/** Index of nearest main task (non-subtask) strictly above `idx`. */
function findNearestMainAbove(tasks, idx) {
  for (let j = idx - 1; j >= 0; j--) {
    if (!tasks[j].subtask) return j;
  }
  return -1;
}

/** First index after the run of subtasks that follow `mainIdx` (end of that subtree in flat list). */
function indexAfterSubtreeOfMain(tasks, mainIdx) {
  let pos = mainIdx + 1;
  while (pos < tasks.length && tasks[pos].subtask) pos++;
  return pos;
}

/**
 * Puts a subtask row directly under its parent main task: after that main and any
 * subtasks already following it (last child under the same parent).
 */
function moveSubtaskUnderParent(tasks, fromIdx) {
  if (fromIdx <= 0) return fromIdx;
  const parentIdx = findNearestMainAbove(tasks, fromIdx);
  if (parentIdx === -1) return fromIdx;
  const insertAt = indexAfterSubtreeOfMain(tasks, parentIdx);
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

(() => {
  const tasksField = document.getElementById("tasks-field");
  if (!tasksField) return;
  const GENERAL_BLOCK_ID = "general";
  const WEEK_CHANGE_EVENT = "week-offset-change";

  const state = {
    tasks: [],
    nextId: 1,
    draggedId: null,
    isDragging: false,
    focusAfterRender: null, // { id, start, end }
  };

  function isTaskEmptyText(text) {
    return (text ?? "").trim() === "";
  }

  const supabase = window.supabaseClient;
  let authUserId = null;
  let isAuthed = false;
  const pendingPersist = new Map();

  function createTask(text = "", checked = false, dbId = null, subtask = false) {
    const id = `task-${state.nextId++}`;
    return { id, dbId, text, checked, subtask: !!subtask };
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
    document.querySelectorAll(".day-rect").forEach((el) => {
      el.style.pointerEvents = enabled ? "auto" : "none";
    });
    document
      .querySelectorAll("#tasks-field .task-text, .day-tasks .task-text")
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

  async function insertOrUpdateTaskInDb(task) {
    if (!isAuthed || !authUserId) return;
    if (!task) return;

    const content = task.text ?? "";
    const completed = !!task.checked;

    if (isTaskEmptyText(content)) {
      await deleteTaskFromDb(task);
      return;
    }

    // If it exists already, update it. Otherwise insert a new row.
    if (task.dbId) {
      const { error } = await supabase
        .from("tasks")
        .update({ content, completed, is_subtask: !!task.subtask })
        .eq("id", task.dbId)
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
        is_subtask: !!task.subtask,
      })
      .select("id")
      .single();

    if (error) {
      console.error("Supabase insert failed:", error);
      return;
    }

    task.dbId = data?.id ?? null;
  }

  async function persistTask(task) {
    if (!task) return;
    const key = task.id;
    if (!key) return;

    const tail = pendingPersist.get(key);
    const next = (tail ?? Promise.resolve())
      .then(() => insertOrUpdateTaskInDb(task))
      .catch((err) => {
        console.error("Supabase persist failed:", err);
      });
    pendingPersist.set(key, next);
    try {
      await next;
    } finally {
      if (pendingPersist.get(key) === next) {
        pendingPersist.delete(key);
      }
    }
  }

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

    // Apply checkbox rule on load: checked tasks move to the bottom.
    const unchecked = state.tasks.filter((t) => !t.checked);
    const checked = state.tasks.filter((t) => t.checked);
    state.tasks = [...unchecked, ...checked];

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
      tasksField.innerHTML = "";
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
    const row = tasksField.querySelector(`.task-row[data-id="${taskId}"]`);
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
    await persistTask(task);
    return { needRender: false };
  }

  function focusTask(id, start, end) {
    const row = tasksField.querySelector(`.task-row[data-id="${id}"]`);
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
    tasksField.innerHTML = "";

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
      commitBtn.setAttribute("aria-label", "Готово");

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "task-delete";
      deleteBtn.setAttribute("aria-label", "Удалить задачу");

      row.appendChild(checkbox);
      row.appendChild(input);
      row.appendChild(commitBtn);
      row.appendChild(deleteBtn);
      list.appendChild(row);

      commitBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
      });
      commitBtn.addEventListener("click", async () => {
        const { needRender } = await syncTaskFromInput(taskId);
        if (needRender) {
          render();
          return;
        }
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
            moveSubtaskUnderParent(state.tasks, idx);
          }
          normalizeSubtaskFlags(state.tasks);
          if (!isTaskEmptyText(task.text)) void persistTask(task);
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
        state.isDragging = true;
        state.draggedId = taskId;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", taskId);
        setGlobalDragPayload(buildDragPayload(task));
      });

      row.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      });

      row.addEventListener("drop", (e) => {
        e.preventDefault();
        if (!isAuthed) return;
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
        if (moved.dbId && !isTaskEmptyText(moved.text)) void persistTask(moved);

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
          const { needRender } = await syncTaskFromInput(taskId);
          if (needRender) render();
        })();
      });
    }

    tasksField.appendChild(list);

    // Recalculate heights after mount so multiline values keep full height.
    tasksField.querySelectorAll(".task-text").forEach((el) => {
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

  function focusLastTask() {
    ensureAtLeastOneTask();
    let lastUnchecked = -1;
    for (let i = state.tasks.length - 1; i >= 0; i--) {
      if (!state.tasks[i].checked) {
        lastUnchecked = i;
        break;
      }
    }
    if (lastUnchecked !== -1) {
      requestAnimationFrame(() => focusTask(state.tasks[lastUnchecked].id));
      return;
    }
    const newTask = createTask("", false, null);
    state.tasks.splice(0, 0, newTask);
    state.focusAfterRender = { id: newTask.id };
    render();
  }

  function toggleCheckedAndReorder(id, caret) {
    const idx = getTaskIndex(id);
    if (idx === -1) return;

    const task = state.tasks[idx];
    task.checked = !task.checked;

    // Checked tasks must move to the bottom.
    if (task.checked) {
      state.tasks.splice(idx, 1);
      state.tasks.push(task);
    } else {
      // Unchecked tasks should return to the unchecked section.
      state.tasks.splice(idx, 1);
      const firstCheckedIndex = state.tasks.findIndex((t) => t.checked);
      const insertIndex = firstCheckedIndex === -1 ? state.tasks.length : firstCheckedIndex;
      state.tasks.splice(insertIndex, 0, task);
    }

    state.focusAfterRender = {
      id: task.id,
      start: caret?.start,
      end: caret?.end,
    };

    // Persist completion state for non-empty tasks.
    if (!isTaskEmptyText(task.text)) void persistTask(task);
    render();
  }

  function insertEmptyTaskBelow(currentId) {
    const idx = getTaskIndex(currentId);
    const insertAt = insertIndexBelowRowUncheckedFirst(state.tasks, idx);
    const inheritSub = idx >= 0 ? !!state.tasks[idx].subtask : false;
    const newTask = createTask("", false, null, inheritSub);
    state.tasks.splice(insertAt, 0, newTask);

    state.focusAfterRender = { id: newTask.id };
    render();
  }

  function splitPasteIntoTasks(currentId, text) {
    const idx = getTaskIndex(currentId);
    if (idx === -1) return;

    const lines = text.split(/\r?\n/);
    const first = lines[0] ?? "";
    state.tasks[idx].text = first;

    const toInsert = [];
    for (let i = 1; i < lines.length; i++) {
      toInsert.push(createTask(lines[i] ?? "", false, null, false));
    }
    const pasteInsertAt = insertIndexBelowRowUncheckedFirst(state.tasks, idx);
    state.tasks.splice(pasteInsertAt, 0, ...toInsert);

    const focusId =
      toInsert.length > 0 ? state.tasks[pasteInsertAt]?.id ?? currentId : currentId;
    state.focusAfterRender = { id: focusId };
    render();
  }

  tasksField.addEventListener("click", (e) => {
    if (state.isDragging) return;
    if (!isAuthed) return;

    const row = e.target.closest(".task-row");
    if (!row) {
      focusLastTask();
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

  tasksField.addEventListener("input", (e) => {
    if (!isAuthed) return;
    const input = e.target;
    if (!input.classList || !input.classList.contains("task-text")) return;

    const row = input.closest(".task-row");
    const id = row?.dataset.id;
    if (!id) return;

    const idx = getTaskIndex(id);
    if (idx === -1) return;
    state.tasks[idx].text = input.value;
    autoSizeTextarea(input);
  });

  tasksField.addEventListener("keydown", (e) => {
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
      const { needRender } = await syncTaskFromInput(id);
      if (needRender) {
        render();
        return;
      }
      insertEmptyTaskBelow(id);
    })();
  });

  tasksField.addEventListener("paste", (e) => {
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

  tasksField.addEventListener("drop", async (e) => {
    e.preventDefault();
    if (!isAuthed) return;

    const payload = getGlobalDragPayload();
    if (!payload) return;
    if (payload.sourceBlock === GENERAL_BLOCK_ID) return;

    const moved = createTask(
      payload.text,
      payload.checked,
      payload.dbId,
      !!payload.subtask
    );
    if (moved.checked) {
      state.tasks.push(moved);
    } else {
      const fc = firstCheckedTaskIndex(state.tasks);
      if (fc === -1) state.tasks.push(moved);
      else state.tasks.splice(fc, 0, moved);
    }
    state.focusAfterRender = { id: moved.id };
    render();

    if (moved.dbId) {
      const { error } = await supabase
        .from("tasks")
        .update({
          type: "general",
          day_name: null,
          date: getVisibleWeekMondayIso(),
          is_subtask: !!moved.subtask,
        })
        .eq("id", moved.dbId)
        .eq("user_id", authUserId);
      if (error) console.error("Supabase move-to-general failed:", error);
    } else if (!isTaskEmptyText(moved.text)) {
      void persistTask(moved);
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
  });

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
  const WEEK_CHANGE_EVENT = "week-offset-change";

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

  function isTaskEmptyText(text) {
    return (text ?? "").trim() === "";
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

    const state = {
      tasks: [],
      nextId: 1,
      draggedId: null,
      isDragging: false,
      focusAfterRender: null, // { id, start, end }
    };
    let currentUserId = null;
    let isAuthed = false;
    const pendingPersist = new Map();

    function createTask(text = "", checked = false, dbId = null, subtask = false) {
      const id = `day-task-${state.nextId++}`;
      return { id, dbId, text, checked, subtask: !!subtask };
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

    async function insertOrUpdateTaskInDb(task) {
      if (!supabase || !isAuthed || !currentUserId || !task) return;
      const content = task.text ?? "";
      const completed = !!task.checked;

      if (isTaskEmptyText(content)) {
        await deleteTaskFromDb(task);
        return;
      }

      if (task.dbId) {
        const { error } = await supabase
          .from("tasks")
          .update({ content, completed, is_subtask: !!task.subtask })
          .eq("id", task.dbId)
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
          is_subtask: !!task.subtask,
        })
        .select("id")
        .single();

      if (error) {
        console.error("Supabase daily insert failed:", error);
        return;
      }

      task.dbId = data?.id ?? null;
    }

    async function persistTask(task) {
      if (!task?.id) return;
      const key = task.id;
      const tail = pendingPersist.get(key);
      const next = (tail ?? Promise.resolve())
        .then(() => insertOrUpdateTaskInDb(task))
        .catch((err) => {
          console.error("Supabase daily persist failed:", err);
        });
      pendingPersist.set(key, next);
      try {
        await next;
      } finally {
        if (pendingPersist.get(key) === next) {
          pendingPersist.delete(key);
        }
      }
    }

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
        id: `day-task-${state.nextId++}`,
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
      ensureAtLeastOneTask();
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
        ensureAtLeastOneTask();
        return { needRender: true };
      }
      await persistTask(task);
      return { needRender: false };
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
        commitBtn.setAttribute("aria-label", "Готово");

        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "task-delete";
        deleteBtn.setAttribute("aria-label", "Удалить задачу");

        const actions = document.createElement("div");
        actions.className = "task-row-actions";
        actions.appendChild(commitBtn);
        actions.appendChild(deleteBtn);

        main.appendChild(actions);
        row.appendChild(checkbox);
        row.appendChild(main);
        list.appendChild(row);

        commitBtn.addEventListener("mousedown", (e) => {
          e.preventDefault();
        });
        commitBtn.addEventListener("click", async () => {
          const { needRender } = await syncTaskFromInput(taskId);
          if (needRender) {
            render();
            return;
          }
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
              moveSubtaskUnderParent(state.tasks, idx);
            }
            normalizeSubtaskFlags(state.tasks);
            if (!isTaskEmptyText(task.text)) void persistTask(task);
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
          state.isDragging = true;
          state.draggedId = taskId;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", taskId);
          setGlobalDragPayload(buildDragPayload(task));
        });

        row.addEventListener("dragover", (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        });

        row.addEventListener("drop", (e) => {
          e.preventDefault();
          if (!isAuthed) return;
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
          if (moved.dbId && !isTaskEmptyText(moved.text)) void persistTask(moved);

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
            const { needRender } = await syncTaskFromInput(taskId);
            if (needRender) render();
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

    function ensureAtLeastOneTask() {
      if (state.tasks.length === 0) {
        state.tasks.push(createTask("", false));
      }
    }

    function focusLastTask() {
      ensureAtLeastOneTask();
      let lastUnchecked = -1;
      for (let i = state.tasks.length - 1; i >= 0; i--) {
        if (!state.tasks[i].checked) {
          lastUnchecked = i;
          break;
        }
      }
      if (lastUnchecked !== -1) {
        state.focusAfterRender = { id: state.tasks[lastUnchecked].id };
        render();
        return;
      }
      const newTask = createTask("", false, null);
      state.tasks.splice(0, 0, newTask);
      state.focusAfterRender = { id: newTask.id };
      render();
    }

    function toggleChecked(id) {
      const idx = getTaskIndex(id);
      if (idx === -1) return;
      const task = state.tasks[idx];
      task.checked = !task.checked;

      if (task.checked) {
        state.tasks.splice(idx, 1);
        state.tasks.push(task);
      } else {
        state.tasks.splice(idx, 1);
        const fc = firstCheckedTaskIndex(state.tasks);
        const insertIndex = fc === -1 ? state.tasks.length : fc;
        state.tasks.splice(insertIndex, 0, task);
      }

      if (!isTaskEmptyText(task.text)) void persistTask(task);
      render();
    }

    function insertEmptyTaskBelow(currentId) {
      const idx = getTaskIndex(currentId);
      const insertAt = insertIndexBelowRowUncheckedFirst(state.tasks, idx);
      const inheritSub = idx >= 0 ? !!state.tasks[idx].subtask : false;
      const newTask = createTask("", false, null, inheritSub);
      state.tasks.splice(insertAt, 0, newTask);
      state.focusAfterRender = { id: newTask.id };
      return newTask;
    }

    function setTextAndMaybeResort(taskId, text, input) {
      const idx = getTaskIndex(taskId);
      if (idx === -1) return;

      const beforeMinutes = parseTimeMinutes(state.tasks[idx].text);
      state.tasks[idx].text = text;
      const afterMinutes = parseTimeMinutes(state.tasks[idx].text);

      if (beforeMinutes === afterMinutes) return;

      stabilizeTimeSorted();
      const taskAfterSort = state.tasks.find((t) => t.id === taskId);
      if (taskAfterSort && isAuthed && !isTaskEmptyText(taskAfterSort.text)) {
        void persistTask(taskAfterSort);
      }
      state.focusAfterRender = {
        id: taskId,
        start: input.selectionStart,
        end: input.selectionEnd,
      };
      render();
    }

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

      focusLastTask();
    });

    tasksEl.addEventListener("input", (e) => {
      if (!isAuthed) return;
      const input = e.target;
      if (!input.classList || !input.classList.contains("task-text")) return;

      const row = input.closest(".task-row");
      const id = row?.dataset.id;
      if (!id) return;

      setTextAndMaybeResort(id, input.value, input);
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
        const { needRender } = await syncTaskFromInput(id);
        if (needRender) {
          render();
          return;
        }
        insertEmptyTaskBelow(id);
        stabilizeTimeSorted();
        render();
      })();
    });

    tasksEl.addEventListener("dragover", (e) => {
      if (!isAuthed) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });

    tasksEl.addEventListener("drop", async (e) => {
      e.preventDefault();
      if (!isAuthed) return;

      const payload = getGlobalDragPayload();
      if (!payload) return;
      if (payload.sourceBlock === blockId) return;

      const moved = createTask(
        moveTimeToStart(payload.text),
        payload.checked,
        payload.dbId,
        !!payload.subtask
      );
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

      if (moved.dbId) {
        const { error } = await supabase
          .from("tasks")
          .update({
            type: "daily",
            day_name: dayMeta.dayName,
            date: dayMeta.date,
            is_subtask: !!moved.subtask,
          })
          .eq("id", moved.dbId)
          .eq("user_id", currentUserId);
        if (error) console.error("Supabase move-to-day failed:", error);
      } else if (!isTaskEmptyText(moved.text)) {
        void persistTask(moved);
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
    });

    async function setAuthUser(userId) {
      isAuthed = !!userId;
      currentUserId = userId || null;

      if (!isAuthed) {
        state.tasks = [];
        tasksEl.innerHTML = "";
        return;
      }

      await loadTasksForDay();
      ensureAtLeastOneTask();
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
      if (state.tasks.length === 0) state.tasks.push(createTask("", false));
      render();
    });

    window.addEventListener(WEEK_CHANGE_EVENT, async () => {
      dayMeta = getDayMeta(dayName);
      if (!isAuthed) return;
      await loadTasksForDay();
      ensureAtLeastOneTask();
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
  const WEEK_CHANGE_EVENT = "week-offset-change";
  window.__weekOffset = Number(window.__weekOffset || 0);

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
    window.__weekOffset = Number(window.__weekOffset || 0) + delta;
    syncWeekAwayClass();
    updateDayOfMonthLabels();
    window.dispatchEvent(new CustomEvent(WEEK_CHANGE_EVENT));
  }

  const prevBtn = document.getElementById("week-prev");
  const nextBtn = document.getElementById("week-next");
  if (prevBtn) prevBtn.addEventListener("click", () => shiftWeek(-1));
  if (nextBtn) nextBtn.addEventListener("click", () => shiftWeek(1));

  syncWeekAwayClass();
  scheduleNextUpdate();
})();

async function signUp() {
  const supabase = window.supabaseClient;
  if (!supabase) {
    console.error("Supabase client missing.");
    return;
  }

  const email = document.getElementById("email").value;
  const password = document.getElementById("password").value;

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
  });

  if (error) {
    alert(error.message);
    return;
  }

  alert("Регистрация успешна!");
  // Main UI subscribes to auth state changes and loads tasks automatically.
}

async function login() {
  const supabase = window.supabaseClient;
  if (!supabase) {
    console.error("Supabase client missing.");
    return;
  }

  const email = document.getElementById("email").value;
  const password = document.getElementById("password").value;

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    alert(error.message);
    return;
  }

  alert("Вход выполнен!");
  // Main UI subscribes to auth state changes and loads tasks automatically.
}

async function logout() {
  const supabase = window.supabaseClient;
  if (!supabase) {
    console.error("Supabase client missing.");
    return;
  }

  const { error } = await supabase.auth.signOut();
  if (error) console.error("Sign out failed:", error);
}

window.addEventListener("load", () => {
  const overlay = document.getElementById("auth-overlay");
  const trigger = document.getElementById("auth-trigger");
  const closeBtn = document.getElementById("auth-close");
  const signupBtn = document.getElementById("auth-signup");
  const loginBtn = document.getElementById("auth-login");
  const logoutBtn = document.getElementById("logout-button");
  const authStatusEl = document.getElementById("auth-status");

  async function refreshAuthStatus() {
    if (!authStatusEl) return;
    const supabase = window.supabaseClient;
    if (!supabase) {
      authStatusEl.textContent = "";
      return;
    }
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const email = session?.user?.email?.trim();
    if (email) {
      authStatusEl.textContent = `Вы вошли в аккаунт: ${email}`;
    } else {
      authStatusEl.textContent = "Вы не вошли в аккаунт";
    }
  }

  if (window.supabaseClient) {
    window.supabaseClient.auth.onAuthStateChange(() => {
      void refreshAuthStatus();
    });
    void refreshAuthStatus();
  }

  function openAuthPopup() {
    if (!overlay) return;
    overlay.hidden = false;
    void refreshAuthStatus();
  }

  function closeAuthPopup() {
    if (!overlay) return;
    overlay.hidden = true;
  }

  if (trigger) trigger.addEventListener("click", openAuthPopup);
  if (closeBtn) closeBtn.addEventListener("click", closeAuthPopup);

  if (overlay) {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeAuthPopup();
    });
  }

  if (signupBtn) {
    signupBtn.addEventListener("click", async () => {
      await signUp();
      closeAuthPopup();
    });
  }

  if (loginBtn) {
    loginBtn.addEventListener("click", async () => {
      await login();
      closeAuthPopup();
    });
  }

  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      await logout();
      closeAuthPopup();
    });
  }
});

