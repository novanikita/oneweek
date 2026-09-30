/* Drives the real UI through a fixed scenario, then dumps DB + DOM state. */
(function () {
  const steps = [];
  const log = (s) => steps.push(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel) => document.querySelector(sel);
  const general = () => $("#tasks-field-root");
  const mainThing = () => $("#main-thing-root");
  const day = (name) => document.getElementById(`day-${name.replace(/\s+/g, "-")}`);

  function rows(container) {
    return [...container.querySelectorAll(".task-row")];
  }
  function row(container, text) {
    const r = rows(container).find((x) => x.querySelector(".task-text")?.value === text);
    if (!r) throw new Error(`row not found: ${text}`);
    return r;
  }
  function anyRow(text) {
    const r = [...document.querySelectorAll(".task-row")].find(
      (x) => x.querySelector(".task-text")?.value === text
    );
    if (!r) throw new Error(`row not found anywhere: ${text}`);
    return r;
  }
  async function clickEmpty(container) {
    container.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    container.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await sleep(120);
  }
  async function type(text) {
    const el = document.activeElement;
    if (!el?.classList.contains("task-text")) throw new Error(`no focused task field for "${text}"`);
    el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(30);
  }
  async function key(k, opts = {}) {
    const el = document.activeElement || document.body;
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts }));
    await sleep(150);
  }
  async function blur() {
    document.activeElement?.blur?.();
    await sleep(200);
  }
  async function focus(r) {
    r.querySelector(".task-text").focus();
    await sleep(60);
  }
  async function click(el) {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    el.click();
    await sleep(200);
  }
  async function setColor(r, index) {
    r.querySelector(".task-color").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await sleep(60);
    const sw = document.querySelectorAll(".task-color-popover .task-color-swatch")[index];
    sw.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await sleep(200);
  }
  async function drag(fromRow, target, { before = true } = {}) {
    const handle = fromRow.querySelector(".task-drag-handle");
    handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    const dt = new DataTransfer();
    fromRow.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
    await sleep(30);
    const rect = target.getBoundingClientRect();
    const clientX = rect.left + Math.min(20, rect.width / 2);
    const clientY = target.classList.contains("task-row")
      ? (before ? rect.top + 2 : rect.bottom - 2)
      : rect.top + Math.min(10, rect.height / 2);
    const init = { bubbles: true, cancelable: true, clientX, clientY, dataTransfer: dt };
    target.dispatchEvent(new DragEvent("dragover", init));
    target.dispatchEvent(new DragEvent("drop", init));
    fromRow.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
    window.dispatchEvent(new MouseEvent("mouseup"));
    await sleep(400);
  }
  async function paste(text) {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    document.activeElement.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })
    );
    await sleep(150);
  }
  async function undo() {
    await blur();
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "z", metaKey: true, ctrlKey: true, bubbles: true })
    );
    await sleep(400);
  }

  function describe(container) {
    return rows(container).map((r) => {
      const text = r.querySelector(".task-text")?.value ?? "";
      const done = r.classList.contains("completed") ? "[x]" : "[ ]";
      const sub = r.classList.contains("task-row-sub") ? "  " : "";
      const color = r.dataset.color ? ` {${r.dataset.color}}` : "";
      return `${sub}${done} ${text}${color}`;
    });
  }
  function snapshot() {
    const wsName = new Map(window.__fakeDb.workspaces.map((w) => [w.id, w.name]));
    const tasks = window.__fakeDb.tasks
      .map((r) => ({
        ws: wsName.get(r.workspace_id) ?? r.workspace_id,
        type: r.type,
        date: r.date,
        day: r.day_name,
        pos: r.position,
        text: r.content,
        done: !!r.completed,
        sub: !!r.is_subtask,
        main: !!r.is_main,
        color: r.color,
      }))
      .sort((a, b) =>
        [a.ws, a.type, a.date, a.day ?? "", a.pos, a.text].join("|").localeCompare(
          [b.ws, b.type, b.date, b.day ?? "", b.pos, b.text].join("|")
        )
      );
    const dom = { main: describe(mainThing()), general: describe(general()) };
    for (const d of document.querySelectorAll(".day-rect")) {
      const list = describe(d.querySelector(".day-tasks"));
      if (list.length) dom[d.dataset.day] = list;
    }
    return {
      tasks,
      workspaces: window.__fakeDb.workspaces.map((w) => `${w.name}${w.is_default ? "*" : ""}`),
      dom,
      week: $("#week-nav-label")?.textContent,
    };
  }

  const checkpoints = {};
  async function scenario() {
    for (let i = 0; i < 100 && !general().querySelector(".tasks-list"); i++) await sleep(50);
    await sleep(300);

    log("general: type three tasks with Enter");
    await clickEmpty(general());
    await type("alpha");
    await key("Enter");
    await type("beta");
    await key("Enter");
    await type("gamma");
    await key("Enter");
    await type("delta");
    await blur();

    log("tab-indent beta under alpha");
    await focus(row(general(), "beta"));
    await key("Tab");
    await blur();

    log("check gamma");
    await click(row(general(), "gamma").querySelector(".task-checkbox"));

    log("star alpha (main thing)");
    await click(row(general(), "alpha").querySelector(".task-star"));
    checkpoints.afterGeneral = snapshot();

    log("monday: timed tasks sort on commit");
    await clickEmpty(day("Monday"));
    await type("call bob 9:30");
    await key("Enter");
    await type("lunch");
    await key("Enter");
    await type("8:00 gym");
    await blur();

    log("color lunch");
    await setColor(row(day("Monday"), "lunch"), 3);

    log("reorder in monday: lunch to top");
    await drag(row(day("Monday"), "lunch"), rows(day("Monday"))[0], { before: true });
    checkpoints.afterMonday = snapshot();

    log("cross move delta general -> tuesday (empty day)");
    await drag(row(general(), "delta"), day("Tuesday"));

    log("cross move gym monday -> general, onto first general row");
    await drag(row(day("Monday"), "08:00 gym"), rows(general())[0], { before: true });
    checkpoints.afterCross = snapshot();

    log("delete alpha subtree (main thing) then undo");
    await click(row(mainThing(), "alpha").querySelector(".task-delete"));
    checkpoints.afterDelete = snapshot();
    await undo();
    checkpoints.afterUndo = snapshot();

    log("paste two lines into a new general task");
    await clickEmpty(general());
    await paste("p1\np2");
    await blur();

    log("enter on empty subtask exits to a main");
    await focus(row(day("Monday"), "lunch"));
    const dbg = (label) => {
      const ae = document.activeElement;
      const r = ae?.closest?.(".task-row");
      log(`DBG ${label}: active=${ae?.tagName}${r ? " row=" + JSON.stringify(ae.value) + (r.classList.contains("task-row-sub") ? " (sub)" : "") : ""} monday=${JSON.stringify(describe(day("Monday")))}`);
    };
    dbg("focused lunch");
    await key("Enter");
    dbg("after Enter on lunch");
    await type("lunch sub");
    await key("Tab");
    dbg("after Tab");
    await key("Enter");
    dbg("after Enter on lunch sub");
    await key("Enter");
    dbg("after Enter on empty sub");
    await type("after exit");
    await blur();
    checkpoints.afterEnter = snapshot();

    log("star a day task -> becomes main thing (displaces alpha)");
    await click(row(day("Monday"), "after exit").querySelector(".task-star"));
    await sleep(500);
    checkpoints.afterPromote = snapshot();

    log("next week: add a task in wednesday, then come back");
    await click($("#week-next"));
    await sleep(500);
    await clickEmpty(day("Wednesday"));
    await type("next week wed");
    await blur();
    checkpoints.nextWeek = snapshot();
    await click($("#week-prev"));
    await sleep(500);

    log("workspace w2: add a task, switch back");
    await window.oneweekWorkspaces.create("w2");
    await sleep(500);
    await clickEmpty(general());
    await type("w2 task");
    await blur();
    checkpoints.inW2 = snapshot();
    await window.oneweekWorkspaces.setActive(window.oneweekWorkspaces.getDefaultWorkspaceId());
    await sleep(600);

    log("uncheck gamma");
    await click(row(general(), "gamma").querySelector(".task-checkbox"));
    await sleep(1500);
  }

  async function scenario2() {
    for (let i = 0; i < 100 && !general().querySelector(".tasks-list"); i++) await sleep(50);
    await sleep(300);

    log("last week: seed an unfinished task for move-remaining");
    await click($("#week-prev"));
    await sleep(500);
    await clickEmpty(general());
    await type("carry me");
    await key("Enter");
    await type("carry sub");
    await key("Tab");
    await blur();
    await click($("#week-next"));
    await sleep(500);

    log("general: A with subtasks, B, C");
    await clickEmpty(general());
    await type("A");
    await key("Enter");
    await type("A1");
    await key("Tab");
    await key("Enter");
    await type("A2");
    await key("Enter");
    await key("Enter");
    await type("B");
    await key("Enter");
    await type("C");
    await blur();
    checkpoints.built = snapshot();

    log("collapse and expand A");
    await click(row(general(), "A").querySelector(".task-subtask-toggle"));
    checkpoints.collapsed = snapshot();
    await click(row(general(), "A").querySelector(".task-subtask-toggle"));

    log("check subtask A1");
    await click(row(general(), "A1").querySelector(".task-checkbox"));
    checkpoints.subChecked = snapshot();

    log("drag B above A");
    await drag(row(general(), "B"), row(general(), "A"), { before: true });
    checkpoints.reordered = snapshot();

    log("star C, then drag it out of the main thing below B");
    await click(row(general(), "C").querySelector(".task-star"));
    await sleep(300);
    await drag(row(mainThing(), "C"), row(general(), "B"), { before: false });
    checkpoints.demoted = snapshot();

    log("drag A (with subtasks) to Wednesday");
    await drag(row(general(), "A"), day("Wednesday"));
    checkpoints.subtreeMoved = snapshot();

    log("delete A in Wednesday, undo");
    await click(row(day("Wednesday"), "A").querySelector(".task-delete"));
    await undo();
    checkpoints.wedUndo = snapshot();

    log("type two Wednesday tasks");
    await clickEmpty(day("Wednesday"));
    await type("y");
    await key("Enter");
    await type("x at 10:00");
    await blur();

    log("indent button on y");
    await click(row(day("Wednesday"), "y").querySelector(".task-indent"));
    await blur();

    log("Enter on an empty main commits and drops it");
    await clickEmpty(day("Wednesday"));
    await key("Enter");
    await blur();
    checkpoints.wedEdits = snapshot();

    log("check / uncheck 10:00 x at");
    await click(row(day("Wednesday"), "10:00 x at").querySelector(".task-checkbox"));
    await click(row(day("Wednesday"), "10:00 x at").querySelector(".task-checkbox"));

    log("color B, then clear it");
    await setColor(row(general(), "B"), 5);
    await setColor(row(general(), "B"), 0);

    log("offline edit, banner, then reconnect");
    window.__fakeOffline = true;
    await focus(row(general(), "B"));
    await type("B offline");
    await blur();
    await sleep(300);
    checkpoints.offline = { ...snapshot(), banner: !$("#connection-banner").hidden };
    window.__fakeOffline = false;
    window.dispatchEvent(new Event("online"));
    await sleep(1200);
    checkpoints.reconnected = { ...snapshot(), banner: !$("#connection-banner").hidden };

    log("move remaining from last week");
    const btn = $("#tasks-move-remaining");
    checkpoints.moveButtonVisible = !btn.hidden;
    await click(btn);
    await sleep(1200);
    checkpoints.moveButtonAfter = !btn.hidden;
    await sleep(1500);
  }

  async function scenario3() {
    for (let i = 0; i < 100 && !general().querySelector(".tasks-list"); i++) await sleep(50);
    await sleep(300);
    log("paste into Monday");
    await clickEmpty(day("Monday"));
    await paste("first\nsecond at 9:15\nthird");
    await blur();
    await sleep(800);
  }

  /** Fixed behaviors: paste siblings, cleared-task delete + undo, time sort, star race, carry-forward groups. */
  async function scenario4() {
    for (let i = 0; i < 100 && !general().querySelector(".tasks-list"); i++) await sleep(50);
    await sleep(300);
    const dbTexts = () => window.__fakeDb.tasks.filter((t) => t.date === window.__fakeDb.tasks.at(-1)?.date);

    log("last week: Proj > step, Other > o1");
    await click($("#week-prev"));
    await sleep(500);
    await clickEmpty(general());
    await type("Proj");
    await key("Enter");
    await type("step");
    await key("Tab");
    await key("Enter");
    await key("Enter");
    await type("Other");
    await key("Enter");
    await type("o1");
    await key("Tab");
    await blur();
    await click(row(general(), "Other").querySelector(".task-star"));
    await sleep(300);
    await clickEmpty(day("Monday"));
    await type("lw monday");
    await key("Enter");
    await type("lw done");
    await blur();
    await click(row(day("Monday"), "lw done").querySelector(".task-checkbox"));
    await click($("#week-next"));
    await sleep(800);
    checkpoints.moveButtonBefore = !$("#tasks-move-remaining").hidden;

    log("this week: P > p1, p2");
    await clickEmpty(general());
    await type("P");
    await key("Enter");
    await type("p1");
    await key("Tab");
    await key("Enter");
    await type("p2");
    await blur();

    log("paste into subtask p1");
    await focus(row(general(), "p1"));
    await paste("p1\nq1\nq2");
    await sleep(300);
    checkpoints.pasteSub = { ...snapshot(), active: document.activeElement?.value };
    await blur();

    log("paste into parent P (blank line skipped)");
    await focus(row(general(), "P"));
    await paste("P\nR\n\n  \nS");
    await sleep(300);
    checkpoints.pasteMain = snapshot();
    await blur();

    log("clear saved S -> deleted; undo restores its text");
    await focus(row(general(), "S"));
    await type("");
    await blur();
    await sleep(300);
    checkpoints.cleared = { ...snapshot(), undoHint: !$("#undo-hint").hidden };
    await undo();
    await sleep(300);
    checkpoints.clearedUndo = snapshot();

    log("clear parent P with subtasks -> kept as empty heading");
    await focus(row(general(), "P"));
    await type("");
    await blur();
    await sleep(300);
    checkpoints.clearedParent = snapshot();

    log("monday: done timed task keeps open order");
    await clickEmpty(day("Monday"));
    await type("14:00 late");
    await key("Enter");
    await type("untimed");
    await key("Enter");
    await type("9:00 early");
    await key("Enter");
    await type("8:00 done");
    await blur();
    await click(row(day("Monday"), "08:00 done").querySelector(".task-checkbox"));
    checkpoints.timed = snapshot();

    log("two quick stars");
    row(general(), "R").querySelector(".task-star").click();
    row(general(), "S").querySelector(".task-star").click();
    await sleep(1000);
    checkpoints.stars = snapshot();

    log("this week gets Proj (no subs); move remaining copies Other > o1 only");
    await clickEmpty(general());
    await type("Proj");
    await blur();
    await click($("#tasks-move-remaining"));
    await sleep(1500);
    checkpoints.moveButtonAfter = !$("#tasks-move-remaining").hidden;
  }

  /** "Next week" column is next week's task list. */
  async function scenario6() {
    for (let i = 0; i < 100 && !general().querySelector(".tasks-list"); i++) await sleep(50);
    await sleep(300);
    checkpoints.moveButtonEmptyLastWeek = !$("#tasks-move-remaining").hidden;
    await clickEmpty(day("Next week"));
    await type("for next week 9:00");
    await key("Enter");
    await type("second");
    await blur();
    checkpoints.thisWeek = snapshot();
    await click($("#week-next"));
    await sleep(800);
    checkpoints.nextWeek = snapshot();
  }

  /** Screenshot fixture: a few tasks, one row left in edit mode (?focus=general|day|done). */
  async function scenario5() {
    for (let i = 0; i < 100 && !general().querySelector(".tasks-list"); i++) await sleep(50);
    await sleep(300);
    await clickEmpty(general());
    await type("Plan the week");
    await key("Enter");
    await type("Book tickets");
    await key("Enter");
    await type("Reply to Anna");
    await blur();
    await click(row(general(), "Reply to Anna").querySelector(".task-checkbox"));
    await clickEmpty(day("Monday"));
    await type("9:30 call bob");
    await key("Enter");
    await type("lunch with the team");
    await blur();
    await setColor(row(day("Monday"), "09:30 call bob"), 5);
    await blur();
    const target = new URLSearchParams(location.search).get("focus") || "general";
    if (target === "main") {
      await click(row(general(), "Plan the week").querySelector(".task-star"));
      await sleep(400);
    }
    const r = {
      general: () => row(general(), "Book tickets"),
      day: () => row(day("Monday"), "09:30 call bob"),
      done: () => row(general(), "Reply to Anna"),
      main: () => row(mainThing(), "Plan the week"),
    }[target]();
    await focus(r);
    r.scrollIntoView({ block: "center" });
    window.dispatchEvent(new Event("resize"));
    await sleep(300);
  }

  /** Sidebar workspace list: add + rename, reorder, protected default, delete. */
  async function scenario7() {
    for (let i = 0; i < 100 && !general().querySelector(".tasks-list"); i++) await sleep(50);
    await sleep(300);
    window.confirm = () => true;
    const list = () => $("#sidebar-workspace-list");
    const names = () => [...list().querySelectorAll(".workspace-list-item")].map(
      (li) => (li.querySelector(".workspace-list-name")?.textContent ?? "") + (li.classList.contains("is-active") ? " (active)" : "")
    );
    const item = (name) =>
      [...list().querySelectorAll(".workspace-list-item")].find((li) => li.querySelector(".workspace-list-name")?.textContent === name);
    const openActions = async (name) => { await click(item(name).querySelector(".workspace-list-more")); };
    const action = (name, label) =>
      [...item(name).querySelectorAll(".workspace-list-actions button")].find((b) => b.textContent === label);
    const addNamed = async (name) => {
      await click(list().querySelector(".workspace-list-add"));
      await sleep(300);
      const input = list().querySelector(".workspace-list-edit");
      input.value = name;
      input.blur();
      await sleep(400);
    };

    await click($("#auth-trigger-mobile"));
    await addNamed("work");
    await addNamed("home");
    checkpoints.added = { names: names(), db: window.__fakeDb.workspaces.map((w) => `${w.name}@${w.position}`) };

    await openActions("home");
    await click(action("home", "Move down"));
    await sleep(400);
    checkpoints.moved = { names: names(), db: window.__fakeDb.workspaces.map((w) => `${w.name}@${w.position}`) };

    await openActions("main");
    checkpoints.mainDeleteDisabled = action("main", "Delete").disabled;
    await openActions("main");

    if (new URLSearchParams(location.search).get("shot")) {
      await openActions("home");
      await sleep(300);
      return;
    }

    await openActions("home");
    await click(action("home", "Delete"));
    await sleep(500);
    await click(item("work").querySelector(".workspace-list-name"));
    await sleep(500);
    checkpoints.final = { names: names(), db: window.__fakeDb.workspaces.map((w) => `${w.name}@${w.position}`), active: window.oneweekWorkspaces.getList().find((w) => w.id === window.oneweekWorkspaces.getActiveId())?.name };
  }

  function finish(error) {
    const pre = document.createElement("pre");
    pre.id = "out";
    pre.textContent = JSON.stringify({
      error: error ? String(error.stack || error) : null,
      steps,
      final: snapshot(),
      checkpoints,
      errors: window.__errs,
      toasts: window.__toasts,
    });
    document.body.appendChild(pre);
  }

  window.addEventListener("load", () => {
    const which = { 2: scenario2, 3: scenario3, 4: scenario4, 5: scenario5, 6: scenario6, 7: scenario7 }[new URLSearchParams(location.search).get("s")] || scenario;
    which().then(() => finish(null), (err) => finish(err));
  });
})();
