/**
 * Task panels — one factory behind the week's general list (with "this week's
 * main thing") and every day column.
 *
 * A panel owns a flat task array (see task-model.js), renders it, persists
 * edits to Supabase, mirrors them into a local cache for offline use, and
 * trades tasks with other panels by drag and drop. Panels differ only in the
 * config passed to `createTaskPanel`: which list they address in the DB, how
 * text is normalized, and how the list settles after an edit.
 */

function setGlobalDragPayload(payload) {
  window.__dragTaskPayload = payload;
}

function clearGlobalDragPayload() {
  window.__dragTaskPayload = null;
}

function sameListAddress(a, b) {
  return (
    !!a &&
    !!b &&
    a.type === b.type &&
    a.date === b.date &&
    (a.dayName ?? null) === (b.dayName ?? null)
  );
}

function relocateFieldsForAddress(address) {
  return { type: address.type, day_name: address.dayName ?? null, date: address.date };
}

const WEEKDAY_INDEX = {
  Monday: 0,
  Tuesday: 1,
  Wednesday: 2,
  Thursday: 3,
  Friday: 4,
  Saturday: 5,
  Sunday: 6,
};

/** DB address of a day column in the visible week. */
function getDayAddress(dayName) {
  const weekStart = getVisibleWeekStartDate();
  const date = new Date(weekStart);
  date.setDate(weekStart.getDate() + (WEEKDAY_INDEX[dayName] ?? 0));
  return { type: "daily", dayName, date: toIsoDateFromDate(date) };
}

/** The week list ("tasks") of the visible week, or of the week after it. */
function getWeekListAddress(weeksAhead = 0) {
  const monday = getWeekMondayStart(new Date(), Number(window.__weekOffset || 0) + weeksAhead);
  return { type: "general", dayName: null, date: toIsoDateFromDate(monday) };
}

/** Config shared by panels that show a week list (main list, "next week" column). */
const WEEK_LIST_PANEL_CONFIG = {
  cacheKey: (userId, address, workspaceId) =>
    generalTasksCacheKey(userId, address.date, workspaceId),
  settle: (tasks) => {
    normalizeMainThingFlags(tasks);
    return partitionKeepingMainThing(tasks);
  },
  partitionInPlace: applyOpenDonePartitionKeepingMainThing,
  togglePartition: partitionKeepingMainThing,
};

/** Config shared by day columns: hh:mm moves to the front and sorts the day. */
const DAY_PANEL_CONFIG = {
  cacheKey: (userId, address, workspaceId) =>
    dailyTasksCacheKey(userId, address.dayName, address.date, workspaceId),
  normalizeText: moveTimeToStart,
  settle: sortTimedTasks,
  partitionInPlace: applyOpenDonePartition,
  togglePartition: partitionUncheckedBeforeChecked,
};

/**
 * @param {object} cfg
 * @param {string} cfg.blockId           Undo / drag identity ("general", "day:Monday").
 * @param {string} cfg.idPrefix          Prefix for local row ids.
 * @param {HTMLElement} cfg.containerEl  Everything the panel renders into.
 * @param {HTMLElement} cfg.listRoot     Where the regular list renders.
 * @param {HTMLElement} cfg.anchorEl     Drop indicator anchor.
 * @param {HTMLElement} cfg.indicatorScrollEl Scroll container for the indicator.
 * @param {HTMLElement} cfg.clickRoot    Receives row / empty-area clicks.
 * @param {HTMLElement} cfg.dropRoot     Receives dragover / drop.
 * @param {HTMLElement} cfg.dragLeaveRoot Leaving it hides the indicator.
 * @param {{el: HTMLElement, root: HTMLElement}|null} cfg.mainThing
 * @param {() => {type: string, dayName: string|null, date: string}} cfg.getAddress
 * @param {(userId: string, address: object, workspaceId: string) => string} cfg.cacheKey
 * @param {(text: string) => string} [cfg.normalizeText]
 * @param {(tasks: object[]) => object[]} cfg.settle  Order after edits/loads.
 * @param {(tasks: object[]) => void} cfg.partitionInPlace  Order after drags/indent.
 * @param {(tasks: object[]) => object[]} cfg.togglePartition  Order after a checkbox.
 */
function createTaskPanel(cfg) {
  const {
    blockId,
    idPrefix,
    containerEl,
    listRoot,
    anchorEl,
    indicatorScrollEl,
    clickRoot,
    dropRoot,
    dragLeaveRoot,
    mainThing = null,
    getAddress,
    cacheKey,
    normalizeText = (text) => text,
    settle,
    partitionInPlace,
    togglePartition,
  } = cfg;

  const supabase = window.supabaseClient;
  const mainThingEl = mainThing?.el ?? null;
  const mainThingRoot = mainThing?.root ?? null;
  const listRoots = mainThingRoot ? [listRoot, mainThingRoot] : [listRoot];

  const state = {
    tasks: [],
    nextId: 1,
    draggedId: null,
    isDragging: false,
    focusAfterRender: null, // { id, start, end }
  };
  let userId = null;
  let isAuthed = false;
  /** Bumps on each load; stale in-flight responses are ignored. */
  let loadGen = 0;
  /** Workspace the visible tasks belong to; guards cache writes. */
  let tasksWorkspaceId = null;
  /** Empty-area click right after editing: save only, do not open a new draft row. */
  let suppressEmptyClickNewTask = false;
  const dropIndicator = createTaskDropIndicator(anchorEl, indicatorScrollEl);

  const mergeContentKey = (t) =>
    defaultTaskMergeContentKey({ ...t, text: normalizeText(String(t.text ?? "")) });

  function newRowId() {
    return `${idPrefix}-${state.nextId++}`;
  }

  function createTask(text = "", checked = false, dbId = null, subtask = false, color = null) {
    return {
      id: newRowId(),
      dbId,
      text,
      checked,
      subtask: !!subtask,
      color: normalizeTaskColor(color),
      isMain: false,
      _dirty: false,
    };
  }

  function getTaskIndex(id) {
    return state.tasks.findIndex((t) => t.id === id);
  }

  function findRow(taskId) {
    return containerEl.querySelector(`.task-row[data-id="${taskId}"]`);
  }

  function buildDragPayload(task) {
    const idx = getTaskIndex(task.id);
    if (idx === -1) return null;
    return buildDragPayloadWithSubtree(state.tasks, idx, blockId, {
      ...relocateFieldsForAddress(getAddress()),
      workspace_id: getActiveWorkspaceId(),
    });
  }

  // --- Persistence -------------------------------------------------------

  function writeCache() {
    if (!isAuthed || !userId) return;
    const wsId = getActiveWorkspaceId();
    if (!wsId || tasksWorkspaceId !== wsId) return;
    writeTasksCache(cacheKey(userId, getAddress(), wsId), state.tasks);
  }

  async function deleteTaskFromDb(task) {
    if (!supabase || !isAuthed || !userId || !task?.dbId) return;
    const { error } = await supabase
      .from("tasks")
      .delete()
      .eq("id", task.dbId)
      .eq("user_id", userId);
    if (error) {
      markNetworkFailure(error);
      console.error("Supabase delete failed:", error);
      throw error;
    }
    markNetworkSuccess();
    task.dbId = null;
  }

  async function insertOrUpdateTaskInDb(task, snapshot) {
    if (!supabase || !isAuthed || !userId || !task) return;
    const source = snapshot || task;
    const content = String(source.text ?? "");
    const completed = !!source.checked;
    const isSubtask = !!source.subtask;
    const isMain = !!source.isMain && !isSubtask;
    const color = normalizeTaskColor(source.color);
    const dbId = source.dbId ?? task.dbId ?? null;

    // Empty text is never written: a draft is not inserted, and a cleared
    // saved task is deleted on commit — unless it still heads subtasks.
    if (isTaskEmptyText(content)) {
      if (!dbId) return;
      const at = taskIndexInList(state.tasks, task);
      if (at === -1 || !mainTaskHasSubtasks(state.tasks, at)) return;
    }

    const idx = taskIndexInList(state.tasks, task);
    const position = idx >= 0 ? idx : state.tasks.length;

    if (dbId) {
      // Content flags only. Never type/date/day_name: a stale persist after a
      // drag to another panel would otherwise move the row back here.
      // Cross-panel moves write those fields explicitly.
      const { error } = await supabase
        .from("tasks")
        .update({ content, completed, is_subtask: isSubtask, is_main: isMain, color, position })
        .eq("id", dbId)
        .eq("user_id", userId);
      if (error) {
        markNetworkFailure(error);
        console.error("Supabase update failed:", error);
        throw error;
      }
      markNetworkSuccess();
      task.savedText = content;
      return;
    }

    const workspaceId = source.workspaceId ?? null;
    if (!workspaceId) {
      throw new Error("Task insert skipped: workspace context missing");
    }
    const address = source.address ?? getAddress();
    const { data, error } = await supabase
      .from("tasks")
      .insert({
        user_id: userId,
        content,
        completed,
        ...relocateFieldsForAddress(address),
        is_subtask: isSubtask,
        is_main: isMain,
        color,
        position,
        workspace_id: workspaceId,
      })
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
    task.savedText = content;
  }

  const persistTask = createPersistTask(
    insertOrUpdateTaskInDb,
    `Supabase persist failed (${blockId}):`,
    // A new row's dbId must reach the cache, or a reload restores it as a
    // draft and the next fetch re-adds it as a duplicate.
    writeCache,
    () => ({ address: getAddress() })
  );

  const schedulePersistTaskPositions = createPositionPersistScheduler(
    supabase,
    () => userId,
    () => state.tasks
  );

  const normalizeCtx = () => ({ markTaskDirty, persistTask });

  function normalizeAndSettle() {
    persistSubtaskNormalizationFixes(normalizeSubtaskFlags(state.tasks), normalizeCtx());
    state.tasks = settle(state.tasks);
  }

  // --- Loading -----------------------------------------------------------

  function taskFromRow(row, i) {
    const text = normalizeText(row.text ?? "");
    return {
      id: newRowId(),
      dbId: row.dbId ?? null,
      text,
      /** Last text known to be in the DB (undo of a cleared task restores it). */
      savedText: row.dbId && !row.dirty ? text : undefined,
      checked: !!row.checked,
      subtask: !!row.subtask,
      color: normalizeTaskColor(row.color),
      position: typeof row.position === "number" ? row.position : i,
      isMain: !!row.isMain,
      _dirty: !!row.dirty,
    };
  }

  function applyCachedTasks(workspaceId) {
    const cached = readTasksCache(cacheKey(userId, getAddress(), workspaceId));
    if (!cached) return false;
    state.tasks = cached.map(taskFromRow);
    normalizeAndSettle();
    syncCollapsedSubtasksFromStorage(state.tasks, workspaceId);
    pruneCollapsedSubtaskStorage(state.tasks, [], workspaceId);
    return true;
  }

  async function load() {
    if (!supabase || !isAuthed || !userId) return;
    const gen = ++loadGen;
    const address = getAddress();
    tasksWorkspaceId = null;

    // Fail closed: an unfiltered query would mix every workspace into one list.
    const workspaceId = getActiveWorkspaceId();
    if (!workspaceId) {
      state.tasks = [];
      render();
      return;
    }

    // Paint the cache first so a flaky network can't hide the user's data;
    // with no cache, clear so another week's tasks never show meanwhile.
    if (!applyCachedTasks(workspaceId)) state.tasks = [];
    // The list belongs to this workspace now: cache writes work even if the
    // server never answers (offline edits survive a reload).
    tasksWorkspaceId = workspaceId;
    render();

    let query = supabase
      .from("tasks")
      .select("id, content, completed, created_at, is_subtask, color, position, is_main")
      .eq("user_id", userId)
      .eq("type", address.type);
    if (address.dayName) query = query.eq("day_name", address.dayName);
    const { data, error } = await query
      .eq("date", address.date)
      .eq("workspace_id", workspaceId)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true });

    if (error) {
      markNetworkFailure(error);
      console.error("Supabase load failed (keeping cached tasks):", error);
      return;
    }
    markNetworkSuccess();

    // The user may have switched week or workspace while this was in flight.
    if (gen !== loadGen) return;
    if (!sameListAddress(address, getAddress())) return;
    if (getActiveWorkspaceId() !== workspaceId) return;

    const serverTasks = (data ?? []).map((row) =>
      taskFromRow({
        dbId: row.id,
        text: row.content,
        checked: row.completed,
        subtask: row.is_subtask,
        color: row.color,
        position: row.position ?? 0,
        isMain: row.is_main,
      })
    );
    state.tasks = mergeLocalEditsIntoServerSnapshot(serverTasks, state.tasks, {
      contentKeyFn: mergeContentKey,
    });
    normalizeAndSettle();
    syncPositionsFromArray(state.tasks);
    tasksWorkspaceId = workspaceId;
    syncCollapsedSubtasksFromStorage(state.tasks, workspaceId);
    pruneCollapsedSubtaskStorage(state.tasks, [], workspaceId);
    writeCache();
    render();

    // Network is back: push local edits that were waiting.
    for (const t of state.tasks) {
      if (t._dirty) void persistTask(t);
    }
  }

  async function setAuthUser(nextUserId) {
    const next = nextUserId || null;
    if (!next) {
      if (!isAuthed && !userId) return;
      isAuthed = false;
      userId = null;
      tasksWorkspaceId = null;
      state.tasks = [];
      render();
      return;
    }
    // Supabase repeats the session on token refresh: skip duplicate loads.
    if (isAuthed && userId === next) return;
    isAuthed = true;
    userId = next;
    await load();
  }

  // --- Main thing (general list only) -----------------------------------

  function resolveMainPromoteIndex(taskId) {
    let idx = getTaskIndex(taskId);
    if (idx !== -1 && state.tasks[idx].subtask) {
      idx = getParentMainTaskIndex(state.tasks, idx);
    }
    return idx;
  }

  function persistMainThingFlag(task) {
    if (!task) return;
    if (isTaskEmptyText(task.text) && !task.dbId) return;
    markTaskDirty(task);
    return persistTask(task);
  }

  async function demoteCurrentMainThing() {
    const idx = getMainThingIndex(state.tasks);
    if (idx === -1) return null;
    const task = state.tasks[idx];
    task.isMain = false;
    await persistMainThingFlag(task);
    return task;
  }

  async function promoteToMainThing(taskId) {
    const idx = resolveMainPromoteIndex(taskId);
    if (idx === -1) return false;
    const target = state.tasks[idx];
    const currentIdx = getMainThingIndex(state.tasks);
    if (currentIdx !== -1 && state.tasks[currentIdx] === target) return false;
    const displaced = await demoteCurrentMainThing();
    if (getTaskIndex(target.id) === -1) return false;
    target.isMain = true;
    await persistMainThingFlag(target);
    normalizeSubtaskFlags(state.tasks);
    partitionInPlace(state.tasks);
    schedulePersistTaskPositions();
    if (displaced) showMainThingLimitToast();
    state.focusAfterRender = { id: target.id };
    render();
    return true;
  }

  async function unstarMainThing() {
    if (getMainThingIndex(state.tasks) === -1) return;
    await demoteCurrentMainThing();
    partitionInPlace(state.tasks);
    schedulePersistTaskPositions();
    render();
  }

  /** Main-thing changes await DB writes; run them one at a time so two quick
   *  stars can't both end up flagged (the DB allows one per week). */
  let mainThingQueue = Promise.resolve();
  function enqueueMainThing(fn) {
    mainThingQueue = mainThingQueue.then(fn).catch((err) => {
      console.error("Main thing update failed:", err);
    });
    return mainThingQueue;
  }

  function toggleMainThing(taskId) {
    return enqueueMainThing(() => {
      const idx = resolveMainPromoteIndex(taskId);
      if (idx === -1) return;
      if (getMainThingIndex(state.tasks) === idx) return unstarMainThing();
      return promoteToMainThing(taskId);
    });
  }

  function eventHitsMainThing(e) {
    if (!mainThingEl) return false;
    const { clientX: x, clientY: y } = e;
    if (typeof x !== "number" || typeof y !== "number") {
      return !!e.target && mainThingEl.contains(e.target);
    }
    const hit = document.elementFromPoint(x, y);
    return !!hit && mainThingEl.contains(hit);
  }

  function setMainThingDropTarget(on) {
    mainThingEl?.classList.toggle("is-drop-target", !!on);
  }

  // --- Edits ---------------------------------------------------------------

  /** Delete saved rows from the DB with a Cmd/Ctrl+Z undo entry. */
  function deleteWithUndo(position, rows) {
    oneweekPushUndo({
      blockId,
      type: "delete-subtree",
      address: getAddress(),
      workspaceId: getActiveWorkspaceId(),
      userId,
      position,
      snapshots: rows.map((t) => ({
        ...cloneTaskSnapshot(t),
        text: isTaskEmptyText(t.text) ? t.savedText ?? "" : t.text,
      })),
    });
    trackPendingTaskDeletes(
      Promise.allSettled(rows.filter((t) => t.dbId).map((t) => deleteTaskFromDb(t)))
    );
    showUndoDeleteHint();
  }

  function removeTaskRow(taskId) {
    const idx = getTaskIndex(taskId);
    if (idx === -1) return;
    const { start, count } = getTaskSubtreeSpan(state.tasks, idx);
    const toRemove = state.tasks.slice(start, start + count);
    deleteWithUndo(start, toRemove);
    state.focusAfterRender = null;
    state.tasks.splice(start, count);
    pruneCollapsedSubtaskStorage(state.tasks, toRemove, getActiveWorkspaceId());
    state.tasks = settle(state.tasks);
    schedulePersistTaskPositions();
    render();
  }

  oneweekRegisterUndoHandler(blockId, async (entry) => {
    if (entry.type !== "delete-subtree") return false;
    // Only restore into the same user, list, and workspace; otherwise the
    // undo loop moves on to the next entry.
    if (!userId || entry.userId !== userId) return false;
    if (!sameListAddress(entry.address, getAddress())) return false;
    if ((entry.workspaceId || null) !== (getActiveWorkspaceId() || null)) return false;
    const snapshots = Array.isArray(entry.snapshots) ? entry.snapshots : [];
    if (snapshots.length === 0) return false;
    await awaitPendingTaskDeletes();

    let insertAt = Math.max(0, Math.min(entry.position ?? state.tasks.length, state.tasks.length));
    let firstRestored = null;
    for (const s of snapshots) {
      const exists = s.dbId && (await taskRowExistsInDb(supabase, userId, s.dbId));
      const restored = createTask(
        normalizeText(s.text ?? ""),
        !!s.checked,
        exists ? s.dbId : null,
        !!s.subtask,
        s.color
      );
      restored.isMain = !!s.isMain;
      state.tasks.splice(insertAt, 0, restored);
      insertAt += 1;
      firstRestored ??= restored;
      if (!exists && !isTaskEmptyText(restored.text)) {
        markTaskDirty(restored);
        void persistTask(restored);
      }
    }
    normalizeAndSettle();
    state.focusAfterRender = { id: firstRestored?.id };
    schedulePersistTaskPositions();
    render();
    return true;
  });

  /**
   * Copy the field's text into state and save it. A cleared task is dropped
   * (drafts) or, on `commit`, deleted with undo; mere flushes (tab hidden)
   * leave that decision to the commit so a half-retyped task survives.
   */
  async function syncTaskFromInput(taskId, { commit = false } = {}) {
    const idx = getTaskIndex(taskId);
    if (idx === -1) return { needRender: true };
    const input = findRow(taskId)?.querySelector(".task-text");
    if (!input) return { needRender: true };
    const text = normalizeText(input.value);
    if (text !== input.value) input.value = text;
    const task = state.tasks[idx];
    task.text = text;
    persistSubtaskNormalizationFixes(normalizeSubtaskFlags(state.tasks), normalizeCtx());
    if (isTaskEmptyText(text) && !task.dbId) {
      // Brand-new draft never persisted — safe to drop from local state.
      state.focusAfterRender = null;
      state.tasks.splice(idx, 1);
      return { needRender: true };
    }
    if (isTaskEmptyText(text) && !mainTaskHasSubtasks(state.tasks, idx)) {
      if (!commit) return { needRender: false };
      removeTaskRow(taskId);
      return { needRender: false, removed: true };
    }
    // Not awaited: the UI would freeze for a network round-trip per blur.
    void persistTask(task);
    return { needRender: false };
  }

  async function commitTask(taskId) {
    const { needRender, removed } = await syncTaskFromInput(taskId, { commit: true });
    if (removed) return false;
    state.tasks = settle(state.tasks);
    schedulePersistTaskPositions();

    // Enter creates + focuses the next row, then the previous field's deferred
    // blur commit lands ~50ms later. Re-rendering then would steal focus from
    // the new draft (whose own blur would drop it as unused), so skip it.
    const ae = document.activeElement;
    const otherTaskFocused =
      ae?.classList?.contains("task-text") &&
      containerEl.contains(ae) &&
      ae.closest(".task-row")?.dataset?.id !== taskId;
    if (otherTaskFocused && !needRender) return true;

    render();
    return !needRender;
  }

  function focusTask(id, start, end) {
    const input = findRow(id)?.querySelector(".task-text");
    if (!input) return;
    input.focus({ preventScroll: true });
    const len = input.value.length;
    if (typeof start === "number" && typeof end === "number") {
      input.setSelectionRange(Math.max(0, Math.min(start, len)), Math.max(0, Math.min(end, len)));
    } else {
      input.setSelectionRange(len, len);
    }
  }

  function toggleChecked(id, caret) {
    const idx = getTaskIndex(id);
    if (idx === -1) return;
    const wasEditing = document.activeElement?.closest?.(".task-row")?.dataset?.id === id;
    const task = toggleAndRepositionTask(state.tasks, idx, togglePartition);
    // Keep the caret only if the row was being edited; a plain checkbox click
    // must not open the field (and the mobile keyboard).
    if (wasEditing) state.focusAfterRender = { id, start: caret?.start, end: caret?.end };
    if (!isTaskEmptyText(task.text)) {
      markTaskDirty(task);
      void persistTask(task);
    }
    schedulePersistTaskPositions();
    render();
  }

  /** Click on empty list area: reuse an unsaved empty draft or insert one, then focus. */
  function beginNewTaskFromEmptyClick() {
    void flushAllTaskSaves();
    const insertAt = insertIndexForNewOpenMain(state.tasks);
    for (let i = insertAt - 1; i >= 0; i--) {
      const t = state.tasks[i];
      // Not a saved row: a cleared parent kept for its subtasks is not a draft.
      if (!t.checked && !t.subtask && !t.dbId && isTaskEmptyText(t.text)) {
        state.focusAfterRender = { id: t.id };
        render();
        return;
      }
    }
    const newTask = createTask("", false, null, false);
    state.tasks.splice(insertAt, 0, newTask);
    state.focusAfterRender = { id: newTask.id };
    render();
  }

  /**
   * Multi-line paste: the first line goes into the current row, the rest
   * become its siblings (subtasks under the same parent, or tasks after the
   * current task's subtasks). Blank lines are skipped. Saved right away.
   */
  function splitPasteIntoTasks(currentId, text) {
    const idx = getTaskIndex(currentId);
    if (idx === -1) return;
    const current = state.tasks[idx];
    const lines = text.split(/\r?\n/);
    current.text = normalizeText(lines[0] ?? "");
    const toInsert = lines
      .slice(1)
      .filter((line) => !isTaskEmptyText(line))
      .map((line) => createTask(normalizeText(line), false, null, current.subtask));
    state.tasks.splice(insertIndexAfterEnterContinue(state.tasks, idx), 0, ...toInsert);
    normalizeSubtaskFlags(state.tasks);
    state.tasks = settle(state.tasks);
    for (const t of [current, ...toInsert]) {
      if (isTaskEmptyText(t.text)) continue;
      markTaskDirty(t);
      void persistTask(t);
    }
    state.focusAfterRender = { id: toInsert[toInsert.length - 1]?.id ?? currentId };
    schedulePersistTaskPositions();
    render();
  }

  /**
   * Enter continues at the same level (main→main, sub→sub).
   * Enter on an empty subtask exits to a new main after the parent group.
   * Enter on an empty main just commits / leaves edit mode.
   */
  async function handleEnterContinue(taskId, inputEl) {
    const idx = getTaskIndex(taskId);
    if (idx === -1) return;
    const task = state.tasks[idx];
    const text = normalizeText(String(inputEl?.value ?? task.text ?? ""));
    if (inputEl && text !== inputEl.value) inputEl.value = text;
    task.text = text;
    const empty = isTaskEmptyText(text);
    const wasSub = !!task.subtask;

    if (empty && wasSub) {
      const parentId = getParentMainTaskId(state.tasks, idx);
      if (task.dbId) deleteWithUndo(idx, [task]);
      state.tasks.splice(idx, 1);
      const neu = createTask("", false, null, false);
      state.tasks.splice(insertIndexAfterEnterExitSub(state.tasks, parentId), 0, neu);
      normalizeSubtaskFlags(state.tasks);
      state.tasks = settle(state.tasks);
      schedulePersistTaskPositions();
      state.focusAfterRender = { id: neu.id };
      render();
      return;
    }

    if (empty) {
      if (!(await commitTask(taskId))) return;
      const active = document.activeElement;
      if (active?.classList?.contains("task-text") && containerEl.contains(active)) active.blur();
      return;
    }

    persistSubtaskNormalizationFixes(normalizeSubtaskFlags(state.tasks), normalizeCtx());
    markTaskDirty(task);
    void persistTask(task);

    const liveIdx = getTaskIndex(taskId);
    if (liveIdx === -1) return;
    if (wasSub) {
      const parentIdx = getParentMainTaskIndex(state.tasks, liveIdx);
      if (parentIdx >= 0) setTaskCollapsed(state.tasks[parentIdx], false);
    }
    const neu = createTask("", false, null, wasSub);
    state.tasks.splice(insertIndexAfterEnterContinue(state.tasks, liveIdx), 0, neu);
    normalizeSubtaskFlags(state.tasks);
    state.tasks = settle(state.tasks);
    schedulePersistTaskPositions();
    state.focusAfterRender = { id: neu.id };
    render();
  }

  function indentCtx() {
    return {
      tasks: state.tasks,
      getTaskIndex,
      persistTask,
      markTaskDirty,
      schedulePersistTaskPositions,
      render,
      reorder: partitionInPlace,
      setFocusAfterRender: (v) => {
        state.focusAfterRender = v;
      },
    };
  }

  // --- Drag and drop -----------------------------------------------------

  function listInMainThing() {
    return mainThingRoot?.querySelector(".tasks-list") ?? null;
  }

  function regularList() {
    return listRoot.querySelector(".tasks-list");
  }

  /**
   * Finish a drag inside this panel. Crossing the main-thing boundary
   * promotes / demotes; `resolveMove` performs the array move.
   */
  function dropWithinPanel(fromId, { overMain, resolveMove }) {
    const fromIdx = getTaskIndex(fromId);
    if (fromIdx === -1) return;
    if (mainThing) {
      const fromInMain = indexIsInMainThingSpan(state.tasks, fromIdx);
      if (overMain && !fromInMain) {
        void enqueueMainThing(() => promoteToMainThing(fromId));
        return;
      }
      if (!overMain && fromInMain) {
        const t = state.tasks[fromIdx];
        if (!t.subtask) {
          t.isMain = false;
          void persistMainThingFlag(t);
        } else {
          t.subtask = false;
        }
      }
    }
    const moved = resolveMove();
    if (!moved) return;
    normalizeSubtaskFlags(state.tasks);
    partitionInPlace(state.tasks);
    schedulePersistTaskPositions();
    state.focusAfterRender = { id: moved.id };
    render();
  }

  function rollbackIncomingMove(payload, insertedLocalIds) {
    rollbackCrossMoveOnTarget(state, insertedLocalIds);
    const backup = takeCrossMoveSourceBackup(payload.localId);
    if (backup) {
      window.dispatchEvent(
        new CustomEvent("task-cross-move-rollback", {
          detail: {
            sourceBlock: payload.sourceBlock,
            targetBlock: blockId,
            position: backup.position,
            snapshots: backup.snapshots,
          },
        })
      );
    }
    state.tasks = settle(state.tasks);
    schedulePersistTaskPositions();
    render();
    clearGlobalDragPayload();
  }

  async function handleIncomingCrossMove(payload, e, { asMain = false } = {}) {
    if (!payload || payload.sourceBlock === blockId) return;
    e.preventDefault?.();
    e.stopPropagation?.();
    e.stopImmediatePropagation?.();

    const overMain = !!mainThing && (asMain || eventHitsMainThing(e));
    const displaced = overMain ? await demoteCurrentMainThing() : null;
    const insertAt = overMain
      ? 0
      : computeCrossInsertIndex(state.tasks, getTaskIndex, e, regularList(), !!payload.checked);
    hideAllTaskDropIndicators();

    const safeInsertAt = Math.max(0, Math.min(insertAt, state.tasks.length));
    const address = getAddress();
    const workspaceId = getActiveWorkspaceId();
    const relocateTarget = {
      ...relocateFieldsForAddress(address),
      workspace_id: workspaceId,
      is_main: overMain,
    };
    const relocateUserId = userId;

    window.dispatchEvent(
      new CustomEvent("task-cross-move", {
        detail: {
          sourceBlock: payload.sourceBlock,
          sourceLocalId: payload.localId,
          targetBlock: blockId,
        },
      })
    );

    const inserted = insertTasksFromCrossPayload(
      state.tasks,
      (text, checked, dbId, sub, color) => createTask(normalizeText(text), checked, dbId, sub, color),
      payload,
      safeInsertAt
    );
    if (overMain && inserted[0]) {
      inserted[0].isMain = true;
      inserted[0].subtask = false;
    }
    syncCollapsedSubtasksFromStorage(state.tasks, workspaceId);
    normalizeSubtaskFlags(state.tasks);
    state.tasks = settle(state.tasks);
    const insertedLocalIds = inserted.map((t) => t.id);
    schedulePersistTaskPositions();
    state.focusAfterRender = { id: inserted[0]?.id };
    if (displaced) showMainThingLimitToast();
    render();

    await flushAllTaskSaves();

    if (!sameListAddress(address, getAddress()) || workspaceId !== getActiveWorkspaceId()) {
      rollbackIncomingMove(payload, insertedLocalIds);
      return;
    }

    const { ok, error } = await relocateCrossMoveSubtree(
      supabase,
      relocateUserId,
      payload,
      relocateTarget,
      safeInsertAt,
      { normalizeContent: normalizeText }
    );
    if (!ok) {
      markNetworkFailure(error);
      console.error(`Supabase move to ${blockId} failed:`, error);
      rollbackIncomingMove(payload, insertedLocalIds);
      return;
    }

    for (const t of inserted) {
      if (!t.dbId && !isTaskEmptyText(t.text)) {
        markTaskDirty(t);
        await persistTask(t);
      }
    }
    clearGlobalDragPayload();
    void flushAllTaskSaves();
  }

  // --- Rendering ---------------------------------------------------------

  function buildRow(task, i, inMain, firstCompletedMainIdx) {
    const taskId = task.id;
    const row = document.createElement("div");
    row.className = `task-row${task.checked ? " completed" : ""}${
      task.subtask ? " task-row-sub" : ""
    }${i === firstCompletedMainIdx ? " task-row-completed-anchor" : ""}`;
    row.dataset.id = taskId;

    const checkbox = document.createElement("button");
    checkbox.type = "button";
    checkbox.className = `task-checkbox${task.checked ? " checked" : ""}`;
    syncTaskCheckboxA11y(checkbox, task.checked);

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
    commitBtn.title = "Done";

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "task-delete";
    wireTaskDeleteButton(deleteBtn);

    const colorBtn = createTaskColorButton();
    syncTaskColorButton(colorBtn, task.color);
    const starBtn = createTaskStarButton(inMain);
    const indentBtn = createTaskIndentButton(!!task.subtask);
    const dragHandle = createTaskDragHandle();

    const main = document.createElement("div");
    main.className = "task-main";
    main.appendChild(input);

    const actions = document.createElement("div");
    actions.className = "task-row-actions";
    actions.append(commitBtn, colorBtn, indentBtn, starBtn, dragHandle, deleteBtn);

    row.append(checkbox, main);
    if (mainTaskHasSubtasks(state.tasks, i)) {
      row.appendChild(
        createSubtaskToggle(task, countSubtasksForMain(state.tasks, i), () => {
          persistCollapsedSubtasksToStorage(state.tasks, tasksWorkspaceId || getActiveWorkspaceId());
          render();
        })
      );
    }
    row.appendChild(actions);

    // Action buttons keep focus in the text field (mobile toolbar stays up).
    for (const btn of [checkbox, commitBtn, deleteBtn]) {
      btn.addEventListener("mousedown", (e) => e.preventDefault());
    }

    commitBtn.addEventListener("click", async () => {
      if (await commitTask(taskId)) input.blur();
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
      row.classList.add("task-row-color-open");
      openTaskColorPicker(
        colorBtn,
        state.tasks[idx].color,
        (next) => {
          const t = state.tasks[getTaskIndex(taskId)];
          if (!t) return;
          const nc = normalizeTaskColor(next);
          if (t.color === nc) return;
          t.color = nc;
          const liveRow = findRow(taskId);
          applyTaskRowColor(liveRow || row, nc);
          syncTaskColorButton(liveRow?.querySelector(".task-color") || colorBtn, nc);
          if (!isTaskEmptyText(t.text)) {
            markTaskDirty(t);
            void persistTask(t);
          }
        },
        input,
        row
      );
    });

    starBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    starBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!isAuthed) return;
      if (mainThing) {
        toggleMainThing(taskId);
        return;
      }
      // Day task: the general panel pulls it in as the main thing.
      window.dispatchEvent(
        new CustomEvent("oneweek-promote-to-main", { detail: { payload: buildDragPayload(task) } })
      );
    });

    indentBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    indentBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!isAuthed) return;
      applyTaskIndentFromButton(indentCtx(), taskId);
    });

    input.addEventListener(
      "keydown",
      (e) => {
        if (!isAuthed) return;
        handleTaskTextTabIndent(e, { ...indentCtx(), taskId });
      },
      true
    );

    wireTaskDragHandle(
      dragHandle,
      row,
      isAuthed,
      (e) => {
        const field = row.querySelector(".task-text");
        if (field) {
          const text = normalizeText(field.value);
          if (text !== field.value) field.value = text;
          task.text = text;
          markTaskDirty(task);
        }
        // No re-sort on dragstart: reshuffling under the pointer looks like
        // the row jumped. Ordering is applied on drop / commit.
        normalizeSubtaskFlags(state.tasks);
        state.isDragging = true;
        state.draggedId = taskId;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", taskId);
        const payload = buildDragPayload(task);
        setGlobalDragPayload(payload);
        writeDragPayloadToDataTransfer(e.dataTransfer, payload);
      },
      () => {
        state.isDragging = false;
        state.draggedId = null;
        clearGlobalDragPayload();
      },
      {
        getListEl: () => (mainThing && row.closest("#main-thing") ? listInMainThing() : regularList()),
        getAnchorEl: () => anchorEl,
        getIndicator: () => dropIndicator,
        getDraggedId: () => state.draggedId || taskId,
        getTaskIndex,
        commit: (clientX, clientY) => {
          const fromId = state.draggedId || taskId;
          state.draggedId = null;
          state.isDragging = false;
          if (tryTouchCrossPanelDrop(clientX, clientY, blockId)) {
            clearGlobalDragPayload();
            return;
          }
          const hit = document.elementFromPoint(clientX, clientY);
          const overMain = !!mainThingEl && !!hit && mainThingEl.contains(hit);
          const listEl = overMain ? listInMainThing() : regularList();
          dropWithinPanel(fromId, {
            overMain,
            resolveMove: () =>
              reorderSubtreeFromTouchPoint(state.tasks, fromId, clientX, clientY, listEl, getTaskIndex),
          });
        },
      }
    );

    row.addEventListener("drop", (e) => {
      e.preventDefault();
      hideAllTaskDropIndicators();
      if (!isAuthed) return;
      const crossPayload = readDragPayloadFromEvent(e);
      if (crossPayload && crossPayload.sourceBlock !== blockId) return;
      const fromId = state.draggedId || e.dataTransfer.getData("text/plain");
      state.draggedId = null;
      state.isDragging = false;
      if (!fromId || fromId === taskId || getTaskIndex(taskId) === -1) return;
      dropWithinPanel(fromId, {
        overMain: !!row.closest("#main-thing"),
        resolveMove: () =>
          reorderSubtreeInArray(
            state.tasks,
            getTaskIndex(fromId),
            getTaskIndex(taskId),
            taskRowInsertBefore(e, row)
          ),
      });
    });

    input.addEventListener("blur", () => {
      if (taskListRerendering > 0) {
        // Our own re-render removed the focused field (Chrome fires blur on
        // removal). Not the user leaving: committing would re-render again
        // and drop the focus this render restores. Just save pending edits.
        const t = state.tasks[getTaskIndex(taskId)];
        if (t?._dirty && !isTaskEmptyText(t.text)) void persistTask(t);
        return;
      }
      scheduleTaskBlurCommit(
        () => commitTask(taskId),
        () => state.isDragging || taskDragInteractionActive
      );
    });

    return row;
  }

  function render() {
    if (!isAuthed) {
      listRoots.forEach(clearTaskListContainer);
      return;
    }
    // Keep the on-disk cache in sync with the live view.
    writeCache();

    const beforeRects = captureTaskRowRects(containerEl);
    listRoots.forEach(clearTaskListContainer);

    const mainSpan = mainThing ? getMainThingSpan(state.tasks) : null;
    const inMainSpan = (i) =>
      !!mainSpan && i >= mainSpan.start && i < mainSpan.start + mainSpan.count;

    let mainList = null;
    if (mainThingRoot) {
      mainList = document.createElement("div");
      mainList.className = "tasks-list";
      if (!mainSpan) {
        const empty = document.createElement("div");
        empty.className = "main-thing-empty";
        empty.setAttribute("aria-hidden", "true");
        mainList.appendChild(empty);
      }
    }
    const list = document.createElement("div");
    list.className = "tasks-list";

    // The first completed main (outside the main thing) gets
    // `margin-top: auto` to pin the done pile to the bottom; CSS alone can't
    // find "first completed main after any mix of subtasks".
    const firstCompletedMainIdx = state.tasks.findIndex(
      (t, i) => t.checked && !t.subtask && !inMainSpan(i)
    );

    for (let i = 0; i < state.tasks.length; i++) {
      const inMain = inMainSpan(i);
      if (!inMain && i === firstCompletedMainIdx) list.appendChild(createTasksListAddSpacer());
      if (isSubtaskRowHidden(state.tasks, i)) continue;
      const row = buildRow(state.tasks[i], i, inMain, firstCompletedMainIdx);
      (inMain ? mainList : list).appendChild(row);
    }

    if (mainList) mainThingRoot.appendChild(mainList);
    listRoot.appendChild(list);
    observeTasksListMinGap(list);

    // Re-measure after mount so multiline values keep their full height.
    containerEl.querySelectorAll(".task-text").forEach(autoSizeTextarea);
    playTaskRowFlip(containerEl, beforeRects);

    if (state.focusAfterRender) {
      const { id, start, end } = state.focusAfterRender;
      state.focusAfterRender = null;
      requestAnimationFrame(() => focusTask(id, start, end));
    }
  }

  // --- Event wiring ------------------------------------------------------

  listRoot.addEventListener(
    "pointerdown",
    (e) => {
      if (!isAuthed) return;
      suppressEmptyClickNewTask = false;
      if (e.target.closest?.(".task-row") || !listRoot.contains(e.target)) return;
      const ae = document.activeElement;
      if (ae?.classList?.contains("task-text") && listRoot.contains(ae)) {
        suppressEmptyClickNewTask = true;
      }
    },
    true
  );

  function onListClick(e, { allowNewTask }) {
    if (state.isDragging || !isAuthed) return;
    const row = e.target.closest(".task-row");
    if (!row) {
      if (!allowNewTask || !listRoot.contains(e.target)) return;
      if (suppressEmptyClickNewTask) {
        suppressEmptyClickNewTask = false;
        void flushAllTaskSaves();
        return;
      }
      beginNewTaskFromEmptyClick();
      return;
    }
    const id = row.dataset.id;
    if (!id || isTaskRowActionTarget(e)) return;
    if (e.target.classList.contains("task-checkbox")) {
      const input = row.querySelector(".task-text");
      toggleChecked(id, input ? { start: input.selectionStart, end: input.selectionEnd } : undefined);
      return;
    }
    focusTaskRowForEdit(row, e.target.classList.contains("task-text") ? e.target : null);
  }

  clickRoot.addEventListener("click", (e) => onListClick(e, { allowNewTask: true }));
  mainThingRoot?.addEventListener("click", (e) => onListClick(e, { allowNewTask: false }));

  for (const root of listRoots) {
    root.addEventListener("input", (e) => {
      if (!isAuthed || !e.target.classList?.contains("task-text")) return;
      const task = state.tasks[getTaskIndex(e.target.closest(".task-row")?.dataset.id)];
      if (!task) return;
      task.text = e.target.value;
      markTaskDirty(task);
      autoSizeTextarea(e.target);
    });

    root.addEventListener("keydown", (e) => {
      if (!isAuthed || !e.target.classList?.contains("task-text")) return;
      if (e.key !== "Enter" || e.shiftKey) return;
      const id = e.target.closest(".task-row")?.dataset.id;
      if (!id || getTaskIndex(id) === -1) return;
      e.preventDefault();
      void handleEnterContinue(id, e.target);
    });

    root.addEventListener("paste", (e) => {
      if (!isAuthed || !e.target.classList?.contains("task-text")) return;
      const text = e.clipboardData?.getData("text") ?? "";
      if (!text.includes("\n")) return;
      const id = e.target.closest(".task-row")?.dataset.id;
      if (!id) return;
      e.preventDefault();
      splitPasteIntoTasks(id, text);
    });
  }

  dropRoot.addEventListener("dragover", (e) => {
    if (!isAuthed || !isActiveTaskDragEvent(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const payload = readDragPayloadFromEvent(e);
    const incoming = !!payload && payload.sourceBlock !== blockId;

    if (mainThing) {
      const fromId = state.draggedId || payload?.localId;
      const fromIdx = fromId ? getTaskIndex(fromId) : -1;
      const fromInMain = indexIsInMainThingSpan(state.tasks, fromIdx);
      if (eventHitsMainThing(e) && (incoming || (fromIdx !== -1 && !fromInMain))) {
        dropIndicator.hide();
        setMainThingDropTarget(true);
        return;
      }
      setMainThingDropTarget(false);
    }

    const list = regularList();
    if (!list) return;
    if (incoming) {
      const insertAt = computeCrossInsertIndex(state.tasks, getTaskIndex, e, list, !!payload.checked);
      showCrossDropIndicator(dropIndicator, list, insertAt, state.tasks);
      return;
    }
    updateTaskDropIndicator(anchorEl, dropIndicator, list, e, state.draggedId, getTaskIndex);
  });

  dragLeaveRoot.addEventListener("dragleave", (e) => {
    if (e.relatedTarget && dragLeaveRoot.contains(e.relatedTarget)) return;
    dropIndicator.hide();
    setMainThingDropTarget(false);
  });

  dropRoot.addEventListener(
    "drop",
    async (e) => {
      if (!isAuthed) return;
      const payload = readDragPayloadFromEvent(e);

      // Same-panel drop: rows handle their own drops; empty space (below the
      // last row, the spacer) appends here or the row would snap back.
      if (payload && payload.sourceBlock === blockId) {
        if (e.target.closest?.(".task-row")) return;
        e.preventDefault();
        e.stopPropagation();
        hideAllTaskDropIndicators();
        const fromId = state.draggedId || payload.localId || e.dataTransfer?.getData?.("text/plain");
        state.draggedId = null;
        state.isDragging = false;
        if (!fromId) return;
        const overMain = eventHitsMainThing(e);
        const listEl = overMain ? listInMainThing() : regularList();
        dropWithinPanel(fromId, {
          overMain,
          resolveMove: () =>
            reorderSubtreeFromSameListDrop(state.tasks, fromId, e, listEl, getTaskIndex),
        });
        return;
      }
      if (payload) await handleIncomingCrossMove(payload, e);
    },
    true
  );

  window.addEventListener("task-touch-cross-drop", async (e) => {
    const detail = e.detail || {};
    if (detail.targetBlock !== blockId || !detail.payload || !isAuthed) return;
    await handleIncomingCrossMove(
      detail.payload,
      syntheticPointerEvent(detail.clientX, detail.clientY)
    );
  });

  // Source side of a cross-panel move: drop the subtree, keep a backup for rollback.
  window.addEventListener("task-cross-move", (e) => {
    const detail = e.detail || {};
    if (detail.sourceBlock !== blockId || detail.targetBlock === blockId) return;
    const idx = getTaskIndex(detail.sourceLocalId);
    if (idx === -1) return;
    const { start, count } = getTaskSubtreeSpan(state.tasks, idx);
    storeCrossMoveSourceBackup(
      detail.sourceLocalId,
      start,
      state.tasks.slice(start, start + count).map(cloneTaskSnapshot)
    );
    state.tasks.splice(start, count);
    render();
  });

  window.addEventListener("task-cross-move-rollback", (e) => {
    const detail = e.detail || {};
    if (detail.sourceBlock !== blockId) return;
    let insertAt = Math.max(0, Math.min(detail.position ?? state.tasks.length, state.tasks.length));
    for (const s of Array.isArray(detail.snapshots) ? detail.snapshots : []) {
      const restored = createTask(normalizeText(s.text ?? ""), !!s.checked, s.dbId || null, !!s.subtask, s.color);
      restored.isMain = !!s.isMain;
      state.tasks.splice(insertAt, 0, restored);
      insertAt += 1;
    }
    normalizeSubtaskFlags(state.tasks);
    state.tasks = settle(state.tasks);
    schedulePersistTaskPositions();
    render();
  });

  if (mainThing) {
    window.addEventListener("oneweek-promote-to-main", async (e) => {
      const payload = e.detail?.payload;
      if (!payload || !isAuthed) return;
      if (payload.sourceBlock === blockId) {
        toggleMainThing(payload.localId);
        return;
      }
      await handleIncomingCrossMove(payload, { clientX: 0, clientY: 0 }, { asMain: true });
    });
  }

  // --- Saving, reconnects, week / workspace switches ----------------------

  async function flushFocusedInput() {
    const active = document.activeElement;
    if (!active?.classList?.contains("task-text") || !containerEl.contains(active)) return;
    const id = active.closest(".task-row")?.dataset.id;
    if (!id) return;
    // A never-saved empty draft has nothing to persist. Syncing it would drop
    // it from state while its row stays focused (e.g. on app switch), so text
    // typed after returning would be silently lost.
    const task = state.tasks[getTaskIndex(id)];
    if (task && !task.dbId && isTaskEmptyText(active.value)) return;
    await syncTaskFromInput(id);
  }

  async function flushDirtyTasks() {
    if (!isAuthed || !userId) return;
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
    await flushFocusedInput();
    await flushDirtyTasks();
  });

  // Network is back: push pending writes, then re-pull for other devices' edits.
  onNetworkRetry(async () => {
    if (!isAuthed) return;
    await flushDirtyTasks();
    await load();
  });

  // Saves were flushed before the week offset / active workspace changed.
  window.addEventListener(WEEK_CHANGE_EVENT, () => {
    if (isAuthed) void load();
  });
  window.addEventListener("workspace-change", () => {
    if (isAuthed) void load();
  });

  function appendPersistedRows(rows) {
    for (const r of rows) {
      state.tasks.push(createTask(normalizeText(r.text), false, r.dbId, r.subtask, r.color));
    }
    normalizeSubtaskFlags(state.tasks);
    state.tasks = settle(state.tasks);
    syncPositionsFromArray(state.tasks);
    render();
    schedulePersistTaskPositions();
  }

  return {
    blockId,
    setAuthUser,
    reload: () => (isAuthed ? load() : undefined),
    appendPersistedRows,
    getTaskCount: () => state.tasks.length,
  };
}

function setTasksInteractivity(enabled) {
  document.getElementById("tasks-field")?.classList.toggle("tasks-field--guest", !enabled);
  document.querySelectorAll(".day-rect").forEach((el) => {
    el.style.pointerEvents = enabled ? "auto" : "none";
  });
  document.querySelectorAll("#tasks-field .task-text, .day-tasks .task-text").forEach((el) => {
    el.readOnly = !enabled;
  });
  document.querySelectorAll(".task-checkbox").forEach((btn) => {
    btn.tabIndex = enabled ? 0 : -1;
  });
}

/**
 * "Move remaining tasks" — on the current week, copies last week's unfinished
 * tasks (its task list, then each day) into this week's list. A copy, not a
 * move, so last week stays as a historical snapshot. The button shows only
 * while there is something to copy and it hasn't been used for this week.
 */
function setupMoveRemaining(generalPanel) {
  const button = document.getElementById("tasks-move-remaining");
  const supabase = window.supabaseClient;
  let userId = null;
  let moveGen = 0;
  let checkGen = 0;

  function doneKey(weekIso, workspaceId) {
    return `oneweek-move-remaining-done-${userId}-${weekIso}-${workspaceId}`;
  }

  function isDone(weekIso, workspaceId) {
    try {
      return localStorage.getItem(doneKey(weekIso, workspaceId)) === "1";
    } catch {
      return false;
    }
  }

  function markDone(weekIso, workspaceId) {
    try {
      localStorage.setItem(doneKey(weekIso, workspaceId), "1");
    } catch {
      /* storage blocked */
    }
  }

  function onThisWeek() {
    return Number(window.__weekOffset || 0) === 0;
  }

  /** Last week's unfinished rows not yet on this week's list; null on error. */
  async function loadRowsToCopy(workspaceId) {
    const lastMonday = getWeekMondayStart(new Date(), -1);
    const lastSunday = new Date(lastMonday);
    lastSunday.setDate(lastMonday.getDate() + 6);
    const lastWeekIso = toIsoDateFromDate(lastMonday);
    const [weekList, days, current] = await Promise.all([
      supabase
        .from("tasks")
        .select("content, is_subtask, color, completed")
        .eq("user_id", userId)
        .eq("workspace_id", workspaceId)
        .eq("type", "general")
        .eq("date", lastWeekIso)
        .order("position", { ascending: true })
        .order("created_at", { ascending: true }),
      supabase
        .from("tasks")
        .select("content, is_subtask, color, completed, date")
        .eq("user_id", userId)
        .eq("workspace_id", workspaceId)
        .eq("type", "daily")
        .gte("date", lastWeekIso)
        .lte("date", toIsoDateFromDate(lastSunday))
        .order("date", { ascending: true })
        .order("position", { ascending: true })
        .order("created_at", { ascending: true }),
      supabase
        .from("tasks")
        .select("content, is_subtask, color")
        .eq("user_id", userId)
        .eq("workspace_id", workspaceId)
        .eq("type", "general")
        .eq("date", getVisibleWeekMondayIso()),
    ]);
    const error = weekList.error || days.error || current.error;
    if (error) {
      markNetworkFailure(error);
      console.error("Move remaining: load failed:", error);
      return null;
    }
    markNetworkSuccess();

    const dayLists = new Map();
    for (const row of days.data ?? []) {
      if (!dayLists.has(row.date)) dayLists.set(row.date, []);
      dayLists.get(row.date).push(row);
    }
    return carryForwardRowsToCopy([weekList.data ?? [], ...dayLists.values()], current.data);
  }

  async function updateButton() {
    if (!button) return;
    const gen = ++checkGen;
    const workspaceId = getActiveWorkspaceId();
    const weekIso = getVisibleWeekMondayIso();
    if (!userId || !onThisWeek() || !workspaceId || isDone(weekIso, workspaceId)) {
      button.hidden = true;
      return;
    }
    const rows = await loadRowsToCopy(workspaceId);
    if (gen !== checkGen) return;
    button.hidden = !(rows && rows.length > 0);
  }

  function contextStillValid(gen, workspaceId, weekIso) {
    return (
      gen === moveGen &&
      workspaceId === getActiveWorkspaceId() &&
      weekIso === getVisibleWeekMondayIso()
    );
  }

  async function run() {
    if (!supabase || !userId || !onThisWeek()) return;
    const workspaceId = getActiveWorkspaceId();
    if (!workspaceId) return;
    const currentWeekIso = getVisibleWeekMondayIso();

    const gen = ++moveGen;
    await flushAllTaskSaves();
    const toCopy = await loadRowsToCopy(workspaceId);
    if (!toCopy || toCopy.length === 0) return;
    if (!contextStillValid(gen, workspaceId, currentWeekIso)) return;

    // Copies are plain tasks: last week's main thing arrives unstarred.
    const basePosition = generalPanel.getTaskCount();
    const { error: insertErr } = await supabase.from("tasks").insert(
      toCopy.map((row, i) => ({
        user_id: userId,
        content: String(row.content ?? ""),
        completed: false,
        type: "general",
        date: currentWeekIso,
        is_subtask: !!row.is_subtask,
        color: normalizeTaskColor(row.color),
        position: basePosition + i,
        workspace_id: workspaceId,
      }))
    );
    if (insertErr) {
      markNetworkFailure(insertErr);
      console.error("Move remaining: insert failed:", insertErr);
      return;
    }
    markNetworkSuccess();
    markDone(currentWeekIso, workspaceId);
    if (!contextStillValid(gen, workspaceId, currentWeekIso)) return;

    // Read the new rows back to learn their ids.
    const { data: refetched, error: refetchErr } = await supabase
      .from("tasks")
      .select("id, content, is_subtask, color, position")
      .eq("user_id", userId)
      .eq("type", "general")
      .eq("date", currentWeekIso)
      .eq("workspace_id", workspaceId)
      .gte("position", basePosition)
      .order("position", { ascending: true });
    if (refetchErr) {
      markNetworkFailure(refetchErr);
      console.error("Move remaining: reconcile load failed:", refetchErr);
      return;
    }
    markNetworkSuccess();

    const matched = matchCarryForwardInsertRows(toCopy, refetched);
    if (matched.some((row) => !row)) {
      console.warn("Move remaining: some inserted rows could not be matched");
    }
    if (!contextStillValid(gen, workspaceId, currentWeekIso)) return;

    const newRows = toCopy
      .map((row, i) =>
        matched[i]?.id
          ? {
              dbId: matched[i].id,
              text: String(row.content ?? ""),
              subtask: !!row.is_subtask,
              color: row.color,
            }
          : null
      )
      .filter(Boolean);
    if (newRows.length > 0) generalPanel.appendPersistedRows(newRows);
  }

  if (button) {
    button.addEventListener("click", async () => {
      if (button.disabled) return;
      button.disabled = true;
      try {
        await run();
      } finally {
        button.disabled = false;
        void updateButton();
      }
    });
  }

  window.addEventListener(WEEK_CHANGE_EVENT, () => void updateButton());
  window.addEventListener("workspace-change", () => void updateButton());

  return {
    setAuthUser(nextUserId) {
      userId = nextUserId || null;
      void updateButton();
    },
    refresh: () => updateButton(),
  };
}

(function setupTaskPanels() {
  const panels = [];

  const tasksField = document.getElementById("tasks-field");
  const tasksFieldRoot = document.getElementById("tasks-field-root");
  const mainThingEl = document.getElementById("main-thing");
  const mainThingRoot = document.getElementById("main-thing-root");
  let moveRemaining = null;

  if (tasksField && tasksFieldRoot) {
    const general = createTaskPanel({
      blockId: "general",
      idPrefix: "task",
      containerEl: tasksField,
      listRoot: tasksFieldRoot,
      anchorEl: tasksField,
      indicatorScrollEl: tasksFieldRoot,
      clickRoot: tasksFieldRoot,
      dropRoot: tasksField,
      dragLeaveRoot: tasksField,
      mainThing: mainThingEl && mainThingRoot ? { el: mainThingEl, root: mainThingRoot } : null,
      getAddress: () => getWeekListAddress(0),
      ...WEEK_LIST_PANEL_CONFIG,
    });
    panels.push(general);
    moveRemaining = setupMoveRemaining(general);
  }

  for (const dayRect of document.querySelectorAll(".day-rect")) {
    const tasksEl = dayRect.querySelector(".day-tasks");
    const dayName = dayRect.dataset.day;
    if (!tasksEl || !dayName) continue;
    // "Next week" is next week's task list itself: when that week comes,
    // its tasks are already in the week's list.
    const isNextWeek = dayName === "Next week";
    panels.push(
      createTaskPanel({
        blockId: `day:${dayName}`,
        // Slug keeps row ids unique across day columns.
        idPrefix: `d-${dayName.replace(/\s+/g, "-")}`,
        containerEl: tasksEl,
        listRoot: tasksEl,
        anchorEl: dayRect,
        indicatorScrollEl: tasksEl,
        clickRoot: dayRect,
        dropRoot: tasksEl,
        dragLeaveRoot: dayRect,
        getAddress: isNextWeek ? () => getWeekListAddress(1) : () => getDayAddress(dayName),
        ...(isNextWeek ? WEEK_LIST_PANEL_CONFIG : DAY_PANEL_CONFIG),
      })
    );
  }

  // Coming back to the app: re-read so edits from other devices show up.
  // Skipped while a task field is being edited (a re-render would drop it).
  const REFRESH_MIN_INTERVAL_MS = 15000;
  let lastRefreshAt = Date.now();
  function refreshOnReturn() {
    if (document.visibilityState !== "visible") return;
    if (Date.now() - lastRefreshAt < REFRESH_MIN_INTERVAL_MS) return;
    if (document.activeElement?.classList?.contains("task-text")) return;
    if (window.__dragTaskPayload) return;
    lastRefreshAt = Date.now();
    for (const panel of panels) void panel.reload();
    void moveRemaining?.refresh();
  }
  document.addEventListener("visibilitychange", refreshOnReturn);
  window.addEventListener("focus", refreshOnReturn);

  // Locked until the session is resolved.
  setTasksInteractivity(false);
  window.oneweekAuth.subscribe((session) => {
    const userId = session?.user?.id ?? null;
    setTasksInteractivity(!!userId);
    moveRemaining?.setAuthUser(userId);
    for (const panel of panels) void panel.setAuthUser(userId);
  });
})();
