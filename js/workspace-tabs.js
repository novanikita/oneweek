/**
 * Workspace tabs UI — top-right strip of buttons that pick the active workspace.
 * Reads/writes state via `window.oneweekWorkspaces`. Listens to the module's
 * events to re-render. Self-contained DOM logic (drag-reorder, rename, delete).
 */
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

  function closeMenu() {
    if (!openMenu) return;
    openMenu.remove();
    openMenu = null;
    document.removeEventListener("mousedown", onDocPointerDown, true);
    document.removeEventListener("keydown", onMenuKey, true);
    window.removeEventListener("blur", closeMenu);
    window.removeEventListener("scroll", closeMenu, true);
  }

  function onDocPointerDown(e) {
    if (!openMenu) return;
    if (openMenu.contains(e.target)) return;
    closeMenu();
  }

  function onMenuKey(e) {
    if (e.key === "Escape") closeMenu();
  }

  function openContextMenu(x, y, items) {
    closeMenu();
    const menu = document.createElement("div");
    menu.className = "workspace-menu";
    menu.setAttribute("role", "menu");
    for (const item of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "workspace-menu-item";
      btn.textContent = item.label;
      if (item.disabled) btn.disabled = true;
      btn.addEventListener("click", () => {
        closeMenu();
        item.onClick?.();
      });
      menu.appendChild(btn);
    }
    document.body.appendChild(menu);

    const rect = menu.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 4;
    const maxY = window.innerHeight - rect.height - 4;
    menu.style.left = `${Math.max(4, Math.min(x, maxX))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, maxY))}px`;

    openMenu = menu;
    document.addEventListener("mousedown", onDocPointerDown, true);
    document.addEventListener("keydown", onMenuKey, true);
    window.addEventListener("blur", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
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
    const item = items.find((w) => w.id === id);
    const msg = item ? `Delete workspace "${item.name}"?` : "Delete workspace?";
    if (typeof window.confirm === "function" && !window.confirm(msg)) return;
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
      input.type = "text";
      input.className = "workspace-tab-edit";
      input.value = item.name;
      input.maxLength = 40;
      // Browser password/credentials autofill heuristics latch onto any text
      // field that sits in a document that also has `<input type="password">`
      // (the auth panel in the sidebar). These attributes opt out of:
      //   - Chromium/WebKit credential heuristics (`autocomplete="off"`,
      //     `name`, `data-form-type="other"`)
      //   - 1Password (`data-1p-ignore`)
      //   - LastPass (`data-lpignore`)
      //   - Bitwarden (`data-bwignore`)
      input.name = "oneweek-workspace-name";
      input.autocomplete = "off";
      input.autocapitalize = "off";
      input.spellcheck = false;
      input.setAttribute("autocorrect", "off");
      input.setAttribute("data-form-type", "other");
      input.setAttribute("data-1p-ignore", "true");
      input.setAttribute("data-lpignore", "true");
      input.setAttribute("data-bwignore", "true");
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
          disabled: items.length <= 1,
          onClick: () => void handleDelete(item.id),
        },
      ]);
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
