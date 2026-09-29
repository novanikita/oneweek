/**
 * Task list model — pure functions over flat task arrays (no DOM, no network).
 *
 * A list is a flat array of `{ id, dbId, text, checked, subtask, color,
 * isMain }`. A main task owns the uninterrupted run of `subtask` rows after
 * it. Shared by the general and day panels in script.js; loaded as a classic
 * script before it, and `require`-able from Node for tests (tests/).
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

function toIsoDateFromDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function isTaskEmptyText(text) {
  return (text ?? "").trim() === "";
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

function normalizeTaskColor(color) {
  if (color == null || color === "") return null;
  const c = String(color).toLowerCase();
  return TASK_COLOR_PALETTE.includes(c) ? c : null;
}

function computeReorderInsertIndex(fromIndex, targetIndex, insertBefore) {
  let insertAt = insertBefore ? targetIndex : targetIndex + 1;
  if (fromIndex >= 0 && fromIndex < insertAt) insertAt--;
  return insertAt;
}

function normalizeSubtaskFlags(tasks) {
  const changed = [];
  for (let i = 0; i < tasks.length; i++) {
    if (!tasks[i].subtask) continue;
    let ok = false;
    for (let j = 0; j < i; j++) {
      if (!tasks[j].subtask) {
        ok = true;
        break;
      }
    }
    if (!ok) {
      tasks[i].subtask = false;
      changed.push(tasks[i]);
    }
  }
  return changed;
}

function canIndentAsSubtask(tasks, idx) {
  if (idx <= 0) return false;
  normalizeSubtaskFlags(tasks);
  const task = tasks[idx];
  if (task.subtask) return false;
  if (mainTaskHasSubtasks(tasks, idx)) return false;
  // Don't pull a regular task into this week's main-thing block via indent.
  if (
    indexIsInMainThingSpan(tasks, idx - 1) &&
    !indexIsInMainThingSpan(tasks, idx)
  ) {
    return false;
  }
  let parentIdx = idx - 1;
  while (parentIdx >= 0 && tasks[parentIdx].subtask) parentIdx -= 1;
  return parentIdx >= 0;
}

function applyTaskSubtaskIndent(tasks, idx, { outdent = false } = {}) {
  if (idx < 0 || idx >= tasks.length) return false;
  const task = tasks[idx];
  if (outdent) {
    if (task.subtask) outdentSubtask(tasks, idx);
    else task.subtask = false;
    return true;
  }
  if (!canIndentAsSubtask(tasks, idx)) return false;
  task.subtask = true;
  moveSubtaskUnderImmediateRowAbove(tasks, idx);
  return true;
}

/** True when local state has unsynced edits that must preserve client-side order. */
function mergeNeedsLocalOrderPreservation(localBefore) {
  if (!localBefore?.length) return false;
  return localBefore.some(
    (t) => t._dirty || (t.dbId == null && !isTaskEmptyText(t.text))
  );
}

function defaultTaskMergeContentKey(t) {
  const color = normalizeTaskColor(t.color) || "";
  return `${String(t.text ?? "").trim()}|${t.checked ? 1 : 0}|${t.subtask ? 1 : 0}|${color}`;
}

/**
 * Combine a server snapshot (ordered by `position`) with unsynced local edits.
 * When nothing is dirty, trust the server order — `position` is authoritative.
 */
function mergeLocalEditsIntoServerSnapshot(
  serverTasks,
  localBefore,
  { contentKeyFn = defaultTaskMergeContentKey } = {}
) {
  if (!mergeNeedsLocalOrderPreservation(localBefore)) {
    return serverTasks.map((srv) => ({ ...srv }));
  }

  const contentKey = contentKeyFn;
  const serverByDbId = new Map();
  for (const s of serverTasks) {
    if (s.dbId) serverByDbId.set(s.dbId, s);
  }

  const usedDbIds = new Set();
  const result = [];

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
          // Unique content match only — avoid attaching a twin's dbId.
          if (bucket && bucket.length === 1) bucket.shift();
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
          isMain: !!local.isMain,
          _dirty: true,
        });
      } else {
        result.push({ ...srv, id: local.id, isMain: !!srv.isMain });
      }
    } else if (!isTaskEmptyText(local.text)) {
      const k = contentKey(local);
      const bucket = unusedServerByContent.get(k);
      // Prefer unique content matches. Ambiguous identical rows: FIFO only for
      // dirty orphans (offline create retry), otherwise leave unmatched.
      let match = null;
      if (bucket && bucket.length === 1) {
        match = bucket.shift();
      } else if (bucket && bucket.length > 1 && local._dirty) {
        match = bucket.shift();
      }
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
          isMain: !!local.isMain,
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

/** First index after the run of subtasks that follow `mainIdx` (end of that subtree in flat list). */
function indexAfterSubtreeOfMain(tasks, mainIdx) {
  let pos = mainIdx + 1;
  while (pos < tasks.length && tasks[pos].subtask) pos++;
  return pos;
}

/** Span of a row plus its subtask run (single row when `idx` is a subtask). */
function getTaskSubtreeSpan(tasks, idx) {
  if (idx < 0 || idx >= tasks.length) return { start: idx, count: 0 };
  if (tasks[idx].subtask) return { start: idx, count: 1 };
  const end = indexAfterSubtreeOfMain(tasks, idx);
  return { start: idx, count: end - idx };
}

function cloneTaskSnapshot(task) {
  return {
    text: task.text ?? "",
    checked: !!task.checked,
    subtask: !!task.subtask,
    color: normalizeTaskColor(task.color),
    dbId: task.dbId ?? null,
    isMain: !!task.isMain,
  };
}

function carryForwardFingerprint(row) {
  const content = String(row.content ?? row.text ?? "").trim();
  const subtask = !!(row.is_subtask ?? row.subtask);
  const color = normalizeTaskColor(row.color) || "";
  return `${content}|${subtask ? 1 : 0}|${color}`;
}

/** Unchecked main groups from last week — keeps subtasks attached to their parent. */
function expandCarryForwardGroups(rows) {
  const tasks = rows.map((r, i) => ({
    id: `carry-${i}`,
    text: String(r.content ?? ""),
    checked: !!(r.completed ?? r.checked ?? false),
    subtask: !!r.is_subtask,
    color: normalizeTaskColor(r.color),
    dbId: null,
  }));
  normalizeSubtaskFlags(tasks);
  const out = [];
  for (const g of splitIntoTaskGroups(tasks)) {
    if (g.main.checked) continue;
    out.push({
      content: g.main.text,
      is_subtask: false,
      color: g.main.color,
    });
    for (const s of g.subs) {
      if (s.checked) continue;
      out.push({
        content: s.text,
        is_subtask: true,
        color: s.color,
      });
    }
  }
  return out;
}

/** Pair carry-forward payloads with server rows by content fingerprint. */
function matchCarryForwardInsertRows(toCopy, serverRows) {
  const pool = [...(serverRows ?? [])];
  return toCopy.map((row) => {
    const fp = carryForwardFingerprint(row);
    const idx = pool.findIndex((r) => carryForwardFingerprint(r) === fp);
    if (idx === -1) return null;
    return pool.splice(idx, 1)[0];
  });
}

function buildDragPayloadWithSubtree(tasks, idx, sourceBlock, sourceRelocate) {
  const { start, count } = getTaskSubtreeSpan(tasks, idx);
  const block = tasks.slice(start, start + count);
  const main = block[0];
  const subtree = block.map(cloneTaskSnapshot);
  const payload = {
    sourceBlock,
    localId: main.id,
    dbId: main.dbId ?? null,
    text: main.text ?? "",
    checked: !!main.checked,
    subtask: !!main.subtask,
    color: normalizeTaskColor(main.color),
    subtree,
  };
  if (sourceRelocate) {
    payload.sourceRelocate = {
      type: sourceRelocate.type,
      day_name: sourceRelocate.day_name ?? null,
      date: sourceRelocate.date,
      workspace_id: sourceRelocate.workspace_id ?? null,
      rows: block.map((t, j) => ({
        dbId: t.dbId ?? null,
        content: String(t.text ?? ""),
        completed: !!t.checked,
        is_subtask: !!t.subtask,
        color: normalizeTaskColor(t.color),
        position: start + j,
      })),
    };
  }
  return payload;
}

function crossMovePayloadRows(payload) {
  if (Array.isArray(payload?.subtree) && payload.subtree.length > 0) {
    return payload.subtree;
  }
  return [
    {
      dbId: payload?.dbId ?? null,
      text: payload?.text ?? "",
      checked: !!payload?.checked,
      subtask: !!payload?.subtask,
      color: normalizeTaskColor(payload?.color),
    },
  ];
}

function insertTasksFromCrossPayload(tasks, createTaskFn, payload, insertAt) {
  const rows = crossMovePayloadRows(payload);
  const safeAt = Math.max(0, Math.min(insertAt, tasks.length));
  const inserted = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const t = createTaskFn(
      r.text ?? "",
      !!r.checked,
      r.dbId || null,
      !!r.subtask,
      normalizeTaskColor(r.color)
    );
    tasks.splice(safeAt + i, 0, t);
    inserted.push(t);
  }
  return inserted;
}

function reorderSubtreeInArray(tasks, fromIndex, targetIndex, insertBefore) {
  if (fromIndex < 0 || targetIndex < 0) return null;
  const { start, count } = getTaskSubtreeSpan(tasks, fromIndex);
  if (count <= 0) return null;
  const subtreeEnd = start + count;
  if (targetIndex >= start && targetIndex < subtreeEnd) return null;

  let insertAt = insertBefore ? targetIndex : targetIndex + 1;
  if (start < insertAt) insertAt -= count;
  if (insertAt === start) return tasks[start];

  const block = tasks.splice(start, count);
  tasks.splice(insertAt, 0, ...block);
  return block[0];
}

function reorderSubtreeToListEnd(tasks, fromIndex) {
  const { start, count } = getTaskSubtreeSpan(tasks, fromIndex);
  if (count <= 0 || start + count >= tasks.length) return null;
  const block = tasks.splice(start, count);
  tasks.push(...block);
  return block[0];
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

/** Outdent a subtask: promote to main and place after its parent's full subtree. */
function outdentSubtask(tasks, idx) {
  if (idx <= 0 || !tasks[idx]?.subtask) return idx;
  let parentIdx = idx - 1;
  while (parentIdx >= 0 && tasks[parentIdx].subtask) parentIdx -= 1;
  const [row] = tasks.splice(idx, 1);
  row.subtask = false;
  if (parentIdx < 0) {
    tasks.splice(idx, 0, row);
    return idx;
  }
  const insertAt = indexAfterSubtreeOfMain(tasks, parentIdx);
  tasks.splice(insertAt, 0, row);
  return insertAt;
}

/**
 * Boundary between the open stack and the completed-mains pile.
 * Checked *subtasks* are ignored — they live inside open parents and must not
 * act as the global "done" fence (Enter / paste / cross-drop / empty-click).
 */
function firstCheckedTaskIndex(tasks) {
  return tasks.findIndex((t) => t.checked && !t.subtask);
}

/**
 * Where to splice a brand-new unchecked main task from an empty-area click:
 * after every open (unchecked-main) group, before the first completed main.
 */
function insertIndexForNewOpenMain(tasks) {
  const span = getMainThingSpan(tasks);
  const from = span ? span.start + span.count : 0;
  for (let i = from; i < tasks.length; i++) {
    if (tasks[i].checked && !tasks[i].subtask) return i;
  }
  return tasks.length;
}

function getMainThingIndex(tasks) {
  return tasks.findIndex((t) => t.isMain && !t.subtask);
}

function getMainThingSpan(tasks) {
  const idx = getMainThingIndex(tasks);
  if (idx === -1) return null;
  return getTaskSubtreeSpan(tasks, idx);
}

function indexIsInMainThingSpan(tasks, idx) {
  const span = getMainThingSpan(tasks);
  if (!span || idx < 0) return false;
  return idx >= span.start && idx < span.start + span.count;
}

function normalizeMainThingFlags(tasks) {
  let kept = false;
  for (const t of tasks) {
    if (t.subtask) {
      t.isMain = false;
      continue;
    }
    if (t.isMain) {
      if (kept) t.isMain = false;
      else kept = true;
    }
  }
}

function partitionKeepingMainThing(tasks) {
  const span = getMainThingSpan(tasks);
  let head = [];
  let rest = tasks;
  if (span) {
    head = tasks.slice(span.start, span.start + span.count);
    rest = tasks.slice(0, span.start).concat(tasks.slice(span.start + span.count));
    if (head[0]) head[0].isMain = true;
    for (let i = 1; i < head.length; i++) head[i].isMain = false;
    const hg = splitIntoTaskGroups(head);
    head = [];
    for (const g of hg) {
      const u = g.subs.filter((s) => !s.checked);
      const c = g.subs.filter((s) => s.checked);
      head.push(g.main, ...u, ...c);
    }
  }
  return head.concat(partitionUncheckedBeforeChecked(rest));
}

function applyOpenDonePartitionKeepingMainThing(tasks) {
  normalizeMainThingFlags(tasks);
  const next = partitionKeepingMainThing(tasks);
  tasks.length = 0;
  for (const t of next) tasks.push(t);
}

/** Re-apply open-above / done-below grouping in place (same-list drag, etc.). */
function applyOpenDonePartition(tasks) {
  const next = partitionUncheckedBeforeChecked(tasks);
  tasks.length = 0;
  for (const t of next) tasks.push(t);
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

function mainTaskHasSubtasks(tasks, mainIdx) {
  if (mainIdx < 0 || mainIdx >= tasks.length) return false;
  if (tasks[mainIdx].subtask) return false;
  return mainIdx + 1 < tasks.length && tasks[mainIdx + 1].subtask;
}

function getParentMainTaskIndex(tasks, subtaskIdx) {
  for (let j = subtaskIdx - 1; j >= 0; j--) {
    if (!tasks[j].subtask) return j;
  }
  return -1;
}

function getParentMainTaskId(tasks, subtaskIdx) {
  const idx = getParentMainTaskIndex(tasks, subtaskIdx);
  return idx >= 0 ? tasks[idx].id : null;
}

function countSubtasksForMain(tasks, mainIdx) {
  if (!mainTaskHasSubtasks(tasks, mainIdx)) return 0;
  return indexAfterSubtreeOfMain(tasks, mainIdx) - mainIdx - 1;
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
 * Where to insert the next sibling after Enter on a filled task.
 * Mains continue after their whole subtask run; subtasks continue right below.
 */
function insertIndexAfterEnterContinue(tasks, idx) {
  if (idx < 0 || idx >= tasks.length) return tasks.length;
  const task = tasks[idx];
  if (task.subtask) return insertIndexBelowRowUncheckedFirst(tasks, idx);
  let insertAt = indexAfterSubtreeOfMain(tasks, idx);
  const fc = firstCheckedTaskIndex(tasks);
  if (!task.checked && fc !== -1 && insertAt > fc) insertAt = fc;
  return insertAt;
}

/**
 * Where to place a new main task after exiting an empty subtask at `removedIdx`
 * (call after the empty row has already been spliced out).
 */
function insertIndexAfterEnterExitSub(tasks, parentId) {
  if (parentId) {
    const parentIdx = tasks.findIndex((t) => t.id === parentId);
    if (parentIdx >= 0) {
      let insertAt = indexAfterSubtreeOfMain(tasks, parentIdx);
      const fc = firstCheckedTaskIndex(tasks);
      if (fc !== -1 && insertAt > fc) insertAt = fc;
      return insertAt;
    }
  }
  const fc = firstCheckedTaskIndex(tasks);
  return fc === -1 ? tasks.length : fc;
}

/**
 * Toggle task completion and reposition the row according to subtask grouping:
 *   - Main tasks fall to / float back from the global completed pile at the
 *     bottom (newly checked land at the TOP of that pile so it grows upward).
 *   - Subtasks stay inside their parent's subtask run: checking sinks them to
 *     the bottom of that run, unchecking pops them to the top.
 */
function toggleAndRepositionTask(tasks, idx, partitionFn = partitionUncheckedBeforeChecked) {
  const task = tasks[idx];
  task.checked = !task.checked;
  const reordered = partitionFn(tasks);
  tasks.length = 0;
  for (const t of reordered) tasks.push(t);
  return task;
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

/**
 * Day-column ordering: timed groups (main starts with hh:mm) are sorted by
 * time among the slots timed groups already occupy, so untimed rows keep
 * their manual places; subtasks sort by time inside their group. Then the
 * usual open-above / done-below grouping applies.
 */
function sortTimedTasks(tasks) {
  const groups = splitIntoTaskGroups(tasks);
  const tagged = groups.map((group, gi) => {
    const subs = group.subs.slice().sort((a, b) => {
      const ma = parseTimeMinutes(a.text);
      const mb = parseTimeMinutes(b.text);
      if (ma == null && mb == null) return 0;
      if (ma == null) return 1;
      if (mb == null) return -1;
      return ma - mb;
    });
    const mainMinutes = parseTimeMinutes(group.main.text);
    return {
      group: { main: group.main, subs },
      gi,
      mainMinutes,
      isTimed: mainMinutes != null,
    };
  });

  const untimedQueue = tagged.filter((t) => !t.isTimed);
  const timedQueue = tagged
    .filter((t) => t.isTimed)
    .sort((a, b) => (a.mainMinutes - b.mainMinutes) || (a.gi - b.gi));

  const result = [];
  for (const group of groups) {
    const mainMinutes = parseTimeMinutes(group.main.text);
    const next = mainMinutes != null ? timedQueue.shift() : untimedQueue.shift();
    if (next) {
      result.push(next.group.main, ...next.group.subs);
    }
  }

  return partitionUncheckedBeforeChecked(result);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    TASK_COLOR_PALETTE,
    getWeekMondayStart,
    toIsoDateFromDate,
    isTaskEmptyText,
    syncPositionsFromArray,
    taskIndexInList,
    normalizeTaskColor,
    computeReorderInsertIndex,
    normalizeSubtaskFlags,
    canIndentAsSubtask,
    applyTaskSubtaskIndent,
    mergeNeedsLocalOrderPreservation,
    defaultTaskMergeContentKey,
    mergeLocalEditsIntoServerSnapshot,
    indexAfterSubtreeOfMain,
    getTaskSubtreeSpan,
    cloneTaskSnapshot,
    carryForwardFingerprint,
    expandCarryForwardGroups,
    matchCarryForwardInsertRows,
    buildDragPayloadWithSubtree,
    crossMovePayloadRows,
    insertTasksFromCrossPayload,
    reorderSubtreeInArray,
    reorderSubtreeToListEnd,
    insertIndexUnderImmediateRowAbove,
    moveSubtaskUnderImmediateRowAbove,
    outdentSubtask,
    firstCheckedTaskIndex,
    insertIndexForNewOpenMain,
    getMainThingIndex,
    getMainThingSpan,
    indexIsInMainThingSpan,
    normalizeMainThingFlags,
    partitionKeepingMainThing,
    applyOpenDonePartitionKeepingMainThing,
    applyOpenDonePartition,
    splitIntoTaskGroups,
    partitionUncheckedBeforeChecked,
    mainTaskHasSubtasks,
    getParentMainTaskIndex,
    getParentMainTaskId,
    countSubtasksForMain,
    insertIndexBelowRowUncheckedFirst,
    insertIndexAfterEnterContinue,
    insertIndexAfterEnterExitSub,
    toggleAndRepositionTask,
    parseTimeMinutes,
    moveTimeToStart,
    sortTimedTasks,
  };
}
