/**
 * Workspace tabs UI — top-right strip of buttons that pick the active workspace.
 * Reads/writes state via `window.oneweekWorkspaces`. Listens to the module's
 * events to re-render. Self-contained DOM logic (drag-reorder, rename, delete).
 */
/**
 * Opt a workspace-name field out of password-manager autofill. Heuristics
 * latch onto any text field in a document that also has the sign-in
 * `<input type="password">`: Chromium/WebKit (`autocomplete`, `name`,
 * `data-form-type`), 1Password, LastPass, Bitwarden.
 */
function configureWorkspaceNameInput(input) {
  input.type = "text";
  input.maxLength = 40;
  input.name = "oneweek-workspace-name";
  input.autocomplete = "off";
  input.autocapitalize = "off";
  input.spellcheck = false;
  input.setAttribute("autocorrect", "off");
  input.setAttribute("data-form-type", "other");
  input.setAttribute("data-1p-ignore", "true");
  input.setAttribute("data-lpignore", "true");
  input.setAttribute("data-bwignore", "true");
}

(() => {
  const container = document.getElementById("workspace-tabs");
  const list = document.getElementById("workspace-tabs-list");
  const addBtn = document.getElementById("workspace-tabs-add");
  if (!container || !list || !addBtn) return;

  const ws = window.oneweekWorkspaces;
  if (!ws) return;

  let renamingId = null;
  let dragId = null;
  let openMenu = null;
  let menuReturnFocus = null;

  function closeMenu() {
    if (!openMenu) return;
    openMenu.remove();
    openMenu = null;
    document.removeEventListener("mousedown", onDocPointerDown, true);
    document.removeEventListener("keydown", onMenuKey, true);
    window.removeEventListener("blur", closeMenu);
    window.removeEventListener("scroll", closeMenu, true);
    const restore = menuReturnFocus;
    menuReturnFocus = null;
    if (restore && typeof restore.focus === "function") {
      restore.focus({ preventScroll: true });
    }
  }

  function onDocPointerDown(e) {
    if (!openMenu) return;
    if (openMenu.contains(e.target)) return;
    closeMenu();
  }

  function onMenuKey(e) {
    if (!openMenu) return;
    const items = [...openMenu.querySelectorAll('[role="menuitem"]:not(:disabled)')];
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement);

    if (e.key === "Escape") {
      e.preventDefault();
      closeMenu();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(idx + 1) % items.length]?.focus();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(idx - 1 + items.length) % items.length]?.focus();
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      items[0]?.focus();
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      items[items.length - 1]?.focus();
    }
  }

  function openContextMenu(x, y, items, returnFocusEl) {
    closeMenu();
    const menu = document.createElement("div");
    menu.className = "workspace-menu";
    menu.setAttribute("role", "menu");
    const menuItems = [];
    for (const item of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "workspace-menu-item";
      btn.setAttribute("role", "menuitem");
      btn.textContent = item.label;
      if (item.disabled) btn.disabled = true;
      btn.addEventListener("click", () => {
        closeMenu();
        item.onClick?.();
      });
      menu.appendChild(btn);
      menuItems.push(btn);
    }
    document.body.appendChild(menu);

    const rect = menu.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 4;
    const maxY = window.innerHeight - rect.height - 4;
    menu.style.left = `${Math.max(4, Math.min(x, maxX))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, maxY))}px`;

    openMenu = menu;
    menuReturnFocus = returnFocusEl || document.activeElement;
    document.addEventListener("mousedown", onDocPointerDown, true);
    document.addEventListener("keydown", onMenuKey, true);
    window.addEventListener("blur", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    requestAnimationFrame(() => {
      (menuItems.find((b) => !b.disabled) || menuItems[0])?.focus({
        preventScroll: true,
      });
    });
  }

  function startRename(id) {
    renamingId = id;
    render();
    requestAnimationFrame(() => {
      const input = list.querySelector(
        `.workspace-tab[data-id="${id}"] .workspace-tab-edit`
      );
      if (input) {
        input.focus();
        input.select();
      }
    });
  }

  async function commitRename(id, newName, originalName) {
    renamingId = null;
    const name = (newName ?? "").trim();
    if (!name || name === originalName) {
      render();
      return;
    }
    await ws.rename(id, name);
    render();
  }

  async function handleCreate() {
    const created = await ws.create();
    if (created?.id) startRename(created.id);
  }

  async function handleDelete(id) {
    const items = ws.getList();
    if (items.length <= 1) return;
    if (ws.isDefaultWorkspace(id)) return;
    const item = items.find((w) => w.id === id);
    const taskCount = await ws.countTasks(id);
    const msg = ws.formatDeleteConfirmMessage(item?.name ?? "", taskCount);
    if (!window.confirm(msg)) return;
    await ws.remove(id);
  }

  function buildTabElement(item, activeId) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "workspace-tab";
    if (item.id === activeId) tab.classList.add("is-active");
    tab.dataset.id = item.id;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(item.id === activeId));
    tab.draggable = true;
    tab.title = item.name;

    if (renamingId === item.id) {
      const input = document.createElement("input");
      configureWorkspaceNameInput(input);
      input.className = "workspace-tab-edit";
      input.value = item.name;
      input.draggable = false;
      input.addEventListener("mousedown", (e) => e.stopPropagation());
      input.addEventListener("click", (e) => e.stopPropagation());
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          input.blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          renamingId = null;
          render();
        }
      });
      input.addEventListener("blur", () => {
        commitRename(item.id, input.value, item.name);
      });
      // Size the input roughly to its content for a nicer feel.
      const measure = Math.max(3, Math.min(input.value.length || 3, 14));
      tab.style.setProperty("--workspace-tab-edit-width", `${measure}ch`);
      tab.appendChild(input);
    } else {
      tab.textContent = item.name;
      tab.addEventListener("click", () => {
        void ws.setActive(item.id);
      });
      tab.addEventListener("dblclick", (e) => {
        e.preventDefault();
        startRename(item.id);
      });
    }

    tab.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const items = ws.getList();
      openContextMenu(e.clientX, e.clientY, [
        { label: "Rename", onClick: () => startRename(item.id) },
        {
          label: "Delete",
          disabled: items.length <= 1 || ws.isDefaultWorkspace(item.id),
          onClick: () => void handleDelete(item.id),
        },
      ], tab);
    });

    tab.addEventListener("dragstart", (e) => {
      if (renamingId === item.id) {
        e.preventDefault();
        return;
      }
      dragId = item.id;
      tab.classList.add("is-dragging");
      try {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", item.id);
      } catch {
        /* some browsers throw on cross-origin pages */
      }
    });

    tab.addEventListener("dragover", (e) => {
      if (!dragId || dragId === item.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect = tab.getBoundingClientRect();
      const before = e.clientX < rect.left + rect.width / 2;
      list
        .querySelectorAll(".workspace-tab")
        .forEach((el) => el.classList.remove("is-drop-before", "is-drop-after"));
      tab.classList.add(before ? "is-drop-before" : "is-drop-after");
    });

    tab.addEventListener("dragleave", () => {
      tab.classList.remove("is-drop-before", "is-drop-after");
    });

    tab.addEventListener("drop", async (e) => {
      if (!dragId || dragId === item.id) return;
      e.preventDefault();
      const rect = tab.getBoundingClientRect();
      const before = e.clientX < rect.left + rect.width / 2;
      const visualOrder = getVisualTabIds();
      const fromIdx = visualOrder.indexOf(dragId);
      if (fromIdx === -1) return;
      visualOrder.splice(fromIdx, 1);
      let targetIdx = visualOrder.indexOf(item.id);
      if (!before) targetIdx += 1;
      visualOrder.splice(targetIdx, 0, dragId);
      list
        .querySelectorAll(".workspace-tab")
        .forEach((el) => el.classList.remove("is-drop-before", "is-drop-after"));
      dragId = null;
      // DB position 0 = oldest (rightmost tab); leftmost = highest position.
      await ws.reorder(visualOrder.slice().reverse());
    });

    tab.addEventListener("dragend", () => {
      dragId = null;
      list
        .querySelectorAll(".workspace-tab")
        .forEach((el) =>
          el.classList.remove("is-drop-before", "is-drop-after", "is-dragging")
        );
    });

    return tab;
  }

  /** Left-to-right in the tab strip: newest next to +, older toward the right. */
  function getVisualTabIds() {
    return [...list.querySelectorAll(".workspace-tab")].map((el) => el.dataset.id);
  }

  function render() {
    const items = ws.getList().slice().reverse();
    const activeId = ws.getActiveId();
    list.innerHTML = "";
    container.hidden = items.length === 0;
    for (const item of items) {
      list.appendChild(buildTabElement(item, activeId));
    }
  }

  addBtn.addEventListener("click", () => {
    void handleCreate();
  });

  window.addEventListener(ws.WORKSPACE_LIST_CHANGE, render);
  window.addEventListener(ws.WORKSPACE_CHANGE, render);

  render();
})();

/**
 * Sidebar workspace list (mobile-only via CSS): switch, rename, reorder,
 * delete, add. Same order as the header tabs (newest first). Each row's
 * "⋯" opens its actions inline.
 */
(() => {
  const section = document.getElementById("sidebar-section-workspaces");
  const listEl = document.getElementById("sidebar-workspace-list");
  if (!section || !listEl) return;

  const ws = window.oneweekWorkspaces;
  if (!ws) return;

  let openId = null;
  let renamingId = null;

  function visualOrder() {
    return ws.getList().reverse();
  }

  function button(className, text, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    if (className) btn.className = className;
    btn.textContent = text;
    btn.addEventListener("click", onClick);
    return btn;
  }

  async function move(id, delta) {
    const order = visualOrder().map((w) => w.id);
    const from = order.indexOf(id);
    const to = from + delta;
    if (from === -1 || to < 0 || to >= order.length) return;
    [order[from], order[to]] = [order[to], order[from]];
    // DB position 0 = oldest; the list shows newest first.
    await ws.reorder(order.reverse());
  }

  async function remove(item) {
    if (ws.isDefaultWorkspace(item.id) || ws.getList().length <= 1) return;
    const taskCount = await ws.countTasks(item.id);
    if (!window.confirm(ws.formatDeleteConfirmMessage(item.name, taskCount))) return;
    openId = null;
    await ws.remove(item.id);
  }

  function startRename(id) {
    renamingId = id;
    openId = null;
    render();
    const input = listEl.querySelector(".workspace-list-edit");
    input?.focus();
    input?.select();
  }

  async function commitRename(id, value, original) {
    if (renamingId !== id) return;
    renamingId = null;
    const name = value.trim();
    if (name && name !== original) await ws.rename(id, name);
    render();
  }

  function renderRow(item, index, count, activeId) {
    const li = document.createElement("li");
    li.className = "workspace-list-item";
    li.classList.toggle("is-active", item.id === activeId);
    li.classList.toggle("is-open", item.id === openId);

    const row = document.createElement("div");
    row.className = "workspace-list-row";

    if (item.id === renamingId) {
      const input = document.createElement("input");
      configureWorkspaceNameInput(input);
      input.className = "sidebar-input workspace-list-edit";
      input.value = item.name;
      input.setAttribute("aria-label", "Workspace name");
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          input.blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          renamingId = null;
          render();
        }
      });
      input.addEventListener("blur", () => void commitRename(item.id, input.value, item.name));
      row.appendChild(input);
    } else {
      const name = button("workspace-list-name", item.name, () => void ws.setActive(item.id));
      if (item.id === activeId) name.setAttribute("aria-current", "true");
      row.appendChild(name);
    }

    const more = button("workspace-list-more", "⋯", () => {
      openId = openId === item.id ? null : item.id;
      render();
    });
    more.setAttribute("aria-label", `Actions for ${item.name}`);
    more.setAttribute("aria-expanded", String(item.id === openId));
    row.appendChild(more);
    li.appendChild(row);

    if (item.id === openId) {
      const actions = document.createElement("div");
      actions.className = "sidebar-actions workspace-list-actions";
      const up = button("", "Move up", () => void move(item.id, -1));
      const down = button("", "Move down", () => void move(item.id, 1));
      const del = button("is-danger", "Delete", () => void remove(item));
      up.disabled = index === 0;
      down.disabled = index === count - 1;
      del.disabled = count <= 1 || ws.isDefaultWorkspace(item.id);
      if (ws.isDefaultWorkspace(item.id)) del.title = "The default workspace can't be deleted";
      actions.append(button("", "Rename", () => startRename(item.id)), up, down, del);
      li.appendChild(actions);
    }
    return li;
  }

  function render() {
    // Keep what is being typed if the list re-renders mid-rename.
    const editing = listEl.querySelector(".workspace-list-edit");
    const pendingName = editing?.value;

    const items = visualOrder();
    const activeId = ws.getActiveId();
    section.hidden = items.length === 0;
    listEl.innerHTML = "";
    items.forEach((item, i) => listEl.appendChild(renderRow(item, i, items.length, activeId)));

    const add = document.createElement("li");
    add.appendChild(
      button("workspace-list-add", "+ Add workspace", async () => {
        const created = await ws.create();
        if (created?.id) startRename(created.id);
      })
    );
    listEl.appendChild(add);

    if (pendingName != null) {
      const input = listEl.querySelector(".workspace-list-edit");
      if (input) {
        input.value = pendingName;
        input.focus();
      }
    }
  }

  window.addEventListener(ws.WORKSPACE_LIST_CHANGE, render);
  window.addEventListener(ws.WORKSPACE_CHANGE, render);

  render();
})();
