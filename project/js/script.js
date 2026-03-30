(() => {
  const tasksField = document.getElementById("tasks-field");
  if (!tasksField) return;

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

  function createTask(text = "", checked = false, dbId = null) {
    const id = `task-${state.nextId++}`;
    return { id, dbId, text, checked };
  }

  function getTaskIndex(id) {
    return state.tasks.findIndex((t) => t.id === id);
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
        .update({ content, completed })
        .eq("id", task.dbId)
        .eq("user_id", authUserId);

      if (error) console.error("Supabase update failed:", error);
      return;
    }

    const { data, error } = await supabase
      .from("tasks")
      .insert({ user_id: authUserId, content, completed, type: "general" })
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

    if (pendingPersist.has(key)) return pendingPersist.get(key);

    const p = insertOrUpdateTaskInDb(task).catch((err) => {
      console.error("Supabase persist failed:", err);
    });
    pendingPersist.set(key, p);
    try {
      await p;
    } finally {
      pendingPersist.delete(key);
    }
  }

  async function loadTasksForUser() {
    if (!supabase) {
      console.error("Supabase client is not initialized.");
      return;
    }
    if (!authUserId) return;

    const { data, error } = await supabase
      .from("tasks")
      .select("id, content, completed, created_at")
      .eq("user_id", authUserId)
      .eq("type", "general")
      .order("created_at", { ascending: true });

    if (error) {
      console.error("Supabase load failed:", error);
      return;
    }

    state.tasks = (data ?? []).map((row) => ({
      id: `task-${state.nextId++}`,
      dbId: row.id,
      text: row.content ?? "",
      checked: !!row.completed,
    }));

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
      row.className = `task-row${task.checked ? " completed" : ""}`;
      row.dataset.id = taskId;
      row.draggable = isAuthed;

      const checkbox = document.createElement("button");
      checkbox.type = "button";
      checkbox.className = `task-checkbox${task.checked ? " checked" : ""}`;
      checkbox.setAttribute("aria-label", "Toggle task");

      const input = document.createElement("input");
      input.type = "text";
      input.className = "task-text";
      input.value = task.text;
      input.autocomplete = "off";

      row.appendChild(checkbox);
      row.appendChild(input);
      list.appendChild(row);

      row.addEventListener("dragstart", (e) => {
        if (!isAuthed) return;
        state.isDragging = true;
        state.draggedId = taskId;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", taskId);
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

        state.focusAfterRender = { id: moved.id };
        render();
      });

      row.addEventListener("dragend", () => {
        state.isDragging = false;
        state.draggedId = null;
      });

      input.addEventListener("blur", () => {
        const idx = getTaskIndex(taskId);
        if (idx === -1) return;
        const currentText = input.value;
        const task = state.tasks[idx];
        task.text = currentText;

        if (isTaskEmptyText(currentText)) {
          if (task.dbId) void deleteTaskFromDb(task);
          state.focusAfterRender = null;
          state.tasks.splice(idx, 1);
          if (state.tasks.length === 0) state.tasks = [createTask("", false, null)];
          render();
          return;
        }

        // Save task content when leaving edit mode.
        void persistTask(task);
      });
    }

    tasksField.appendChild(list);

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
    const last = state.tasks[state.tasks.length - 1];
    if (!last) return;
    requestAnimationFrame(() => focusTask(last.id));
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
    const insertAt = idx === -1 ? state.tasks.length : idx + 1;
    const newTask = createTask("", false);
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
      toInsert.push(createTask(lines[i] ?? "", false));
    }
    state.tasks.splice(idx + 1, 0, ...toInsert);

    const focusId = idx === -1 ? null : state.tasks[idx + 1]?.id ?? currentId;
    state.focusAfterRender = { id: focusId || currentId };
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
    const isText = e.target.classList.contains("task-text");
    if (!isCheckbox && !isText) return;

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
  });

  tasksField.addEventListener("keydown", (e) => {
    if (!isAuthed) return;
    const input = e.target;
    if (!input.classList || !input.classList.contains("task-text")) return;
    if (e.key !== "Enter") return;

    e.preventDefault();

    const row = input.closest(".task-row");
    const id = row?.dataset.id;
    if (!id) return;

    const idx = getTaskIndex(id);
    if (idx === -1) return;
    const currentText = input.value;

    const task = state.tasks[idx];
    task.text = currentText;

    // Save current task text unless it's whitespace-only (then delete it).
    if (isTaskEmptyText(currentText)) {
      if (task.dbId) void deleteTaskFromDb(task);
      state.tasks.splice(idx, 1);
      const newTask = createTask("", false, null);
      state.tasks.splice(idx, 0, newTask);
      state.focusAfterRender = { id: newTask.id };
      render();
      return;
    }

    // Persist before creating the next empty task.
    void persistTask(task);
    insertEmptyTaskBelow(id);
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

  void initAuth();
})();

(() => {
  const dayRects = document.querySelectorAll(".day-rect");
  if (dayRects.length === 0) return;
  const supabase = window.supabaseClient;

  function getMondayStart() {
    const now = new Date();
    const todayDow = now.getDay(); // 0=Sun..6=Sat
    const mondayOffset = (todayDow + 6) % 7;
    const weekStart = new Date(now);
    weekStart.setHours(0, 0, 0, 0);
    weekStart.setDate(now.getDate() - mondayOffset);
    return weekStart;
  }

  function toIsoDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function getDayMeta(dayName) {
    const weekStart = getMondayStart();
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
      return { dayName, date: toIsoDate(nextMonday) };
    }

    const idx = indexMap[dayName];
    const date = new Date(weekStart);
    date.setDate(weekStart.getDate() + (idx ?? 0));
    return { dayName, date: toIsoDate(date) };
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

  function setupDay(dayRect) {
    const tasksEl = dayRect.querySelector(".day-tasks");
    if (!tasksEl) return;
    const dayName = dayRect.dataset.day || "";
    const dayMeta = getDayMeta(dayName);

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

    function createTask(text = "", checked = false, dbId = null) {
      const id = `day-task-${state.nextId++}`;
      return { id, dbId, text, checked };
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
          .update({ content, completed })
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
      if (pendingPersist.has(task.id)) return pendingPersist.get(task.id);

      const p = insertOrUpdateTaskInDb(task).catch((err) => {
        console.error("Supabase daily persist failed:", err);
      });

      pendingPersist.set(task.id, p);
      try {
        await p;
      } finally {
        pendingPersist.delete(task.id);
      }
    }

    async function loadTasksForDay() {
      if (!supabase || !isAuthed || !currentUserId) return;

      const { data, error } = await supabase
        .from("tasks")
        .select("id, content, completed, created_at")
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
        text: row.content ?? "",
        checked: !!row.completed,
      }));
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

      state.tasks = result;
    }

    function render() {
      tasksEl.innerHTML = "";

      const list = document.createElement("div");
      list.className = "tasks-list";

      for (const task of state.tasks) {
        const taskId = task.id;
        const timeMinutes = parseTimeMinutes(task.text);

        const row = document.createElement("div");
        row.className = `task-row${task.checked ? " completed" : ""}`;
        row.dataset.id = taskId;
        row.draggable = isAuthed;

        const checkbox = document.createElement("button");
        checkbox.type = "button";
        checkbox.className = `task-checkbox${task.checked ? " checked" : ""}`;
        checkbox.setAttribute("aria-label", "Toggle task");

        const input = document.createElement("input");
        input.type = "text";
        input.className = "task-text";
        input.value = task.text;
        input.autocomplete = "off";

        const main = document.createElement("div");
        main.className = "task-main";
        main.appendChild(input);

        if (timeMinutes != null) {
          const bar = document.createElement("div");
          bar.className = "task-time-bar";
          main.appendChild(bar);
        }

        row.appendChild(checkbox);
        row.appendChild(main);
        list.appendChild(row);

        row.addEventListener("dragstart", (e) => {
          if (!isAuthed) return;
          state.isDragging = true;
          state.draggedId = taskId;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", taskId);
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

          state.focusAfterRender = { id: moved.id };
          render();
        });

        row.addEventListener("dragend", () => {
          state.isDragging = false;
          state.draggedId = null;
        });

        input.addEventListener("blur", () => {
          const idx = getTaskIndex(taskId);
          if (idx === -1) return;
          const currentText = input.value;
          const task = state.tasks[idx];
          task.text = currentText;

          if (isTaskEmptyText(currentText)) {
            if (task.dbId) void deleteTaskFromDb(task);
            state.focusAfterRender = null;
            state.tasks.splice(idx, 1);
            stabilizeTimeSorted();
            render();
            return;
          }

          void persistTask(task);
        });
      }

      tasksEl.appendChild(list);

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
      const last = state.tasks[state.tasks.length - 1];
      if (!last) return;
      state.focusAfterRender = { id: last.id };
      render();
    }

    function toggleChecked(id) {
      const idx = getTaskIndex(id);
      if (idx === -1) return;
      state.tasks[idx].checked = !state.tasks[idx].checked;
      // Important: completion toggle should not reorder tasks.
      if (!isTaskEmptyText(state.tasks[idx].text)) void persistTask(state.tasks[idx]);
      render();
    }

    function insertEmptyTaskBelow(currentId) {
      const idx = getTaskIndex(currentId);
      const insertAt = idx === -1 ? state.tasks.length : idx + 1;
      const newTask = createTask("", false);
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
      const isText = e.target.classList && e.target.classList.contains("task-text");

      if (row) {
        const id = row.dataset.id;
        if (!id) return;

        if (isCheckbox) {
          toggleChecked(id);
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
    });

    tasksEl.addEventListener("keydown", (e) => {
      if (!isAuthed) return;
      const input = e.target;
      if (!input.classList || !input.classList.contains("task-text")) return;
      if (e.key !== "Enter") return;

      e.preventDefault();

      const row = input.closest(".task-row");
      const id = row?.dataset.id;
      if (!id) return;

      const idx = getTaskIndex(id);
      if (idx === -1) return;

      const currentText = input.value;
      const task = state.tasks[idx];
      task.text = currentText;
      if (isTaskEmptyText(currentText)) {
        // Remove empty task and keep an empty placeholder for continuing input.
        if (task.dbId) void deleteTaskFromDb(task);
        state.tasks.splice(idx, 1);
        const newTask = createTask("", false);
        state.tasks.splice(idx, 0, newTask);
        stabilizeTimeSorted();
        state.focusAfterRender = { id: newTask.id };
        render();
        return;
      }

      void persistTask(task);
      insertEmptyTaskBelow(id);
      stabilizeTimeSorted();
      render();
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
    const now = new Date();
    const todayDow = now.getDay(); // 0=Sun..6=Sat
    const mondayOffset = (todayDow + 6) % 7; // 0 when today is Monday

    const weekStart = new Date(now);
    weekStart.setHours(0, 0, 0, 0);
    weekStart.setDate(now.getDate() - mondayOffset);

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
  const btn = document.getElementById("logout-button");
  if (!btn) return;
  btn.addEventListener("click", () => {
    void logout();
  });
});

