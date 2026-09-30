// Run: node --test tests/   (Node 18+)
const test = require("node:test");
const assert = require("node:assert/strict");
const m = require("../js/task-model.js");

let seq = 0;
/** Task factory: t("buy milk", { sub: true, done: true, main: true, db: "x" }). */
function t(text, { sub = false, done = false, main = false, db = null, color = null } = {}) {
  seq += 1;
  return { id: `t${seq}`, dbId: db, text, checked: done, subtask: sub, color, isMain: main };
}
const texts = (tasks) => tasks.map((x) => (x.subtask ? `  ${x.text}` : x.text));

test("week helpers: Monday start, ISO date, offsets", () => {
  const sunday = new Date(2026, 8, 27, 15, 30); // Sun 27 Sep 2026
  assert.equal(m.toIsoDateFromDate(m.getWeekMondayStart(sunday)), "2026-09-21");
  assert.equal(m.toIsoDateFromDate(m.getWeekMondayStart(new Date(2026, 8, 21))), "2026-09-21");
  assert.equal(m.toIsoDateFromDate(m.getWeekMondayStart(sunday, 1)), "2026-09-28");
  assert.equal(m.toIsoDateFromDate(m.getWeekMondayStart(sunday, -1)), "2026-09-14");
});

test("normalizeTaskColor keeps only palette colors", () => {
  assert.equal(m.normalizeTaskColor("#EBEBEB"), "#ebebeb");
  assert.equal(m.normalizeTaskColor("#123456"), null);
  assert.equal(m.normalizeTaskColor(""), null);
  assert.equal(m.normalizeTaskColor(null), null);
});

test("splitIntoTaskGroups: subtasks attach to the main above", () => {
  const groups = m.splitIntoTaskGroups([t("a"), t("a1", { sub: true }), t("b")]);
  assert.deepEqual(groups.map((g) => [g.main.text, g.subs.map((s) => s.text)]), [
    ["a", ["a1"]],
    ["b", []],
  ]);
});

test("partitionUncheckedBeforeChecked: done groups sink, done subtasks sink inside group", () => {
  const list = [
    t("done main", { done: true }),
    t("x", { sub: true }),
    t("open"),
    t("s-done", { sub: true, done: true }),
    t("s-open", { sub: true }),
  ];
  assert.deepEqual(texts(m.partitionUncheckedBeforeChecked(list)), [
    "open",
    "  s-open",
    "  s-done",
    "done main",
    "  x",
  ]);
});

test("normalizeSubtaskFlags promotes a leading orphan subtask", () => {
  const list = [t("orphan", { sub: true }), t("a"), t("a1", { sub: true })];
  const changed = m.normalizeSubtaskFlags(list);
  assert.deepEqual(changed.map((x) => x.text), ["orphan"]);
  assert.deepEqual(texts(list), ["orphan", "a", "  a1"]);
});

test("canIndentAsSubtask rules", () => {
  const list = [t("a"), t("b"), t("b1", { sub: true }), t("c")];
  assert.equal(m.canIndentAsSubtask(list, 0), false, "first row has no parent");
  assert.equal(m.canIndentAsSubtask(list, 1), false, "main with subtasks");
  assert.equal(m.canIndentAsSubtask(list, 2), false, "already a subtask");
  assert.equal(m.canIndentAsSubtask(list, 3), true);

  const withMain = [t("main thing", { main: true }), t("regular")];
  assert.equal(m.canIndentAsSubtask(withMain, 1), false, "never pulled into the main thing");
});

test("applyTaskSubtaskIndent: indent under row above, outdent after parent subtree", () => {
  const list = [t("a"), t("a1", { sub: true }), t("b")];
  assert.equal(m.applyTaskSubtaskIndent(list, 2), true);
  assert.deepEqual(texts(list), ["a", "  a1", "  b"]);

  const list2 = [t("a"), t("a1", { sub: true }), t("a2", { sub: true }), t("c")];
  m.applyTaskSubtaskIndent(list2, 1, { outdent: true });
  assert.deepEqual(texts(list2), ["a", "  a2", "a1", "c"]);
});

test("reorderSubtreeInArray moves a main with its subtasks", () => {
  const list = [t("a"), t("a1", { sub: true }), t("b"), t("c")];
  const moved = m.reorderSubtreeInArray(list, 0, 3, false);
  assert.equal(moved.text, "a");
  assert.deepEqual(texts(list), ["b", "c", "a", "  a1"]);

  const list2 = [t("a"), t("a1", { sub: true }), t("b")];
  assert.equal(m.reorderSubtreeInArray(list2, 0, 1, true), null, "cannot drop into own subtree");
});

test("reorderSubtreeToListEnd", () => {
  const list = [t("a"), t("a1", { sub: true }), t("b")];
  m.reorderSubtreeToListEnd(list, 0);
  assert.deepEqual(texts(list), ["b", "a", "  a1"]);
  assert.equal(m.reorderSubtreeToListEnd(list, 1), null, "already last");
});

test("Enter insert positions", () => {
  const list = [t("a"), t("a1", { sub: true }), t("b"), t("done", { done: true })];
  assert.equal(m.insertIndexAfterEnterContinue(list, 0), 2, "main: after its subtree");
  assert.equal(m.insertIndexAfterEnterContinue(list, 1), 2, "subtask: right below");
  assert.equal(m.insertIndexAfterEnterContinue(list, 2), 3, "before the done pile");
  assert.equal(m.insertIndexAfterEnterExitSub(list, list[0].id), 2);
  assert.equal(m.insertIndexAfterEnterExitSub(list, null), 3);
  assert.equal(m.insertIndexBelowRowUncheckedFirst(list, 3), 3, "never below a done row");
});

test("insertIndexForNewOpenMain skips the main thing and stops at done", () => {
  const list = [t("mt", { main: true }), t("mt1", { sub: true }), t("a"), t("d", { done: true })];
  assert.equal(m.insertIndexForNewOpenMain(list), 3);
  assert.equal(m.insertIndexForNewOpenMain([]), 0);
});

test("main thing: one per list, stays on top even when done", () => {
  const list = [t("a", { main: true }), t("b", { main: true }), t("s", { sub: true, main: true })];
  m.normalizeMainThingFlags(list);
  assert.deepEqual(list.map((x) => x.isMain), [true, false, false]);

  const list2 = [t("x"), t("mt", { main: true, done: true }), t("mt1", { sub: true })];
  assert.deepEqual(texts(m.partitionKeepingMainThing(list2)), ["mt", "  mt1", "x"]);
  assert.deepEqual(m.getMainThingSpan(list2), { start: 1, count: 2 });
  assert.equal(m.indexIsInMainThingSpan(list2, 2), true);
  assert.equal(m.indexIsInMainThingSpan(list2, 0), false);
});

test("toggleAndRepositionTask: checked main lands on top of the done pile", () => {
  const list = [t("a"), t("b"), t("old done", { done: true })];
  m.toggleAndRepositionTask(list, 0);
  assert.deepEqual(texts(list), ["b", "a", "old done"]);
  assert.equal(list[1].checked, true);
});

test("merge: clean local state takes server order", () => {
  const server = [t("s2", { db: "2" }), t("s1", { db: "1" })];
  const local = [t("s1", { db: "1" }), t("s2", { db: "2" })];
  assert.deepEqual(texts(m.mergeLocalEditsIntoServerSnapshot(server, local)), ["s2", "s1"]);
});

test("merge: dirty edits and unsynced drafts survive", () => {
  const server = [t("one", { db: "1" }), t("two", { db: "2" }), t("new elsewhere", { db: "3" })];
  const edited = Object.assign(t("one edited", { db: "1" }), { _dirty: true });
  const draft = Object.assign(t("offline draft"), { _dirty: true });
  const local = [draft, edited, t("two", { db: "2" })];
  const merged = m.mergeLocalEditsIntoServerSnapshot(server, local);
  assert.deepEqual(texts(merged), ["offline draft", "one edited", "two", "new elsewhere"]);
  assert.equal(merged[0].dbId, null);
  assert.equal(merged[1].dbId, "1");
  assert.equal(merged[1].id, edited.id, "keeps the local row id");
});

test("merge: an unsynced draft adopts a unique server twin", () => {
  const server = [t("same text", { db: "9" })];
  const local = [t("same text")];
  const merged = m.mergeLocalEditsIntoServerSnapshot(server, local);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].dbId, "9");
});

test("carry forward: open groups only, done subtasks dropped", () => {
  const rows = [
    { content: "open", is_subtask: false, completed: false },
    { content: "open sub", is_subtask: true, completed: false },
    { content: "done sub", is_subtask: true, completed: true },
    { content: "done main", is_subtask: false, completed: true },
    { content: "its sub", is_subtask: true, completed: false },
  ];
  assert.deepEqual(
    m.expandCarryForwardGroups(rows).map((r) => `${r.is_subtask ? "  " : ""}${r.content}`),
    ["open", "  open sub"]
  );
  const matched = m.matchCarryForwardInsertRows(
    [{ content: "a", is_subtask: false }, { content: "a", is_subtask: false }],
    [{ id: 1, content: "a", is_subtask: false }, { id: 2, content: "a", is_subtask: false }]
  );
  assert.deepEqual(matched.map((r) => r.id), [1, 2]);
});

test("time helpers", () => {
  assert.equal(m.parseTimeMinutes("call at 9:05"), 545);
  assert.equal(m.parseTimeMinutes("25:00 nope"), null);
  assert.equal(m.moveTimeToStart("call mom 9:05 please"), "09:05 call mom please");
  assert.equal(m.moveTimeToStart("no time"), "no time");
  assert.equal(m.moveTimeToStart("7:30"), "07:30");
});

test("sortTimedTasks sorts timed rows within timed slots, untimed stay put", () => {
  const list = [t("14:00 late"), t("untimed"), t("09:00 early"), t("done", { done: true })];
  assert.deepEqual(texts(m.sortTimedTasks(list)), ["09:00 early", "untimed", "14:00 late", "done"]);
});

test("drag payload carries the subtree with source positions", () => {
  const list = [t("x"), t("a", { db: "A" }), t("a1", { sub: true, db: "A1" }), t("b")];
  const p = m.buildDragPayloadWithSubtree(list, 1, "general", {
    type: "general",
    date: "2026-09-28",
    workspace_id: "w",
  });
  assert.deepEqual(p.subtree.map((s) => s.text), ["a", "a1"]);
  assert.deepEqual(p.sourceRelocate.rows.map((r) => [r.dbId, r.position]), [["A", 1], ["A1", 2]]);

  const target = [t("y")];
  const inserted = m.insertTasksFromCrossPayload(target, (text, checked, dbId, sub) => t(text, { sub, db: dbId, done: checked }), p, 1);
  assert.deepEqual(texts(target), ["y", "a", "  a1"]);
  assert.deepEqual(inserted.map((x) => x.dbId), ["A", "A1"]);
});

test("sortTimedTasks: done timed rows do not take open slots", () => {
  const list = [t("14:00 late"), t("untimed"), t("09:00 early"), t("done 08:00", { done: true })];
  assert.deepEqual(texts(m.sortTimedTasks(list)), ["09:00 early", "untimed", "14:00 late", "done 08:00"]);
});

test("sortTimedTasks: subtasks sort by time, open before done", () => {
  const list = [t("a"), t("15:00 s", { sub: true }), t("08:00 d", { sub: true, done: true }), t("09:00 s", { sub: true })];
  assert.deepEqual(texts(m.sortTimedTasks(list)), ["a", "  09:00 s", "  15:00 s", "  08:00 d"]);
});

test("carryForwardRowsToCopy: whole groups, across lists, no duplicates", () => {
  const row = (content, { sub = false, done = false } = {}) => ({ content, is_subtask: sub, completed: done });
  const weekList = [row("Project"), row("step 1", { sub: true }), row("Other"), row("o1", { sub: true }), row("", { sub: true })];
  const monday = [row("call bob"), row("done", { done: true }), row("Other")];
  const tuesday = [row("orphan", { sub: true }), row("")];
  const current = [{ content: "Project", is_subtask: false }];
  assert.deepEqual(
    m.carryForwardRowsToCopy([weekList, monday, tuesday], current).map((r) => `${r.is_subtask ? "  " : ""}${r.content}`),
    ["Other", "  o1", "call bob", "orphan"]
  );
});
