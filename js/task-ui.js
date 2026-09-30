/**
 * Task row UI toolkit shared by every task panel (task-panel.js): row
 * buttons and colors, textarea sizing, FLIP animation, drag handles and drop
 * indicators, cross-panel moves, subtask collapsing, and the mobile
 * placement of the edit toolbar.
 */

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

  // Clear any CSS max-height while measuring so wrapped text can report a
  // real scrollHeight (mobile single-line rows use max-height: var(--task-line)).
  const prevMaxHeight = el.style.maxHeight;
  el.style.maxHeight = "none";
  el.style.height = "0";
  syncTaskRowMultiline(el);

  // For single-line rows we always pin the height to the exact computed
  // line-height + paddings. Using scrollHeight here causes ±1px jitter
  // between empty and filled rows because browsers round scrollHeight to a
  // whole pixel while the CSS line-height is fractional (e.g. 19.2 vs 20).
  const oneLineHeight = getTaskInputOneLineHeight(el);
  const isMultiline = row?.classList.contains("task-row-multiline");
  let safeHeight = isMultiline
    ? Math.max(el.scrollHeight, oneLineHeight) + 2
    : oneLineHeight;
  el.style.height = `${safeHeight}px`;

  // Re-measure once if the multiline flag toggled — applying the new height
  // can change scrollHeight (e.g. wider single-line content reflows narrower).
  if (wasMultiline !== isMultiline) {
    el.style.height = "0";
    safeHeight = isMultiline
      ? Math.max(el.scrollHeight, oneLineHeight) + 2
      : oneLineHeight;
    el.style.height = `${safeHeight}px`;
  }
  el.style.maxHeight = prevMaxHeight;
}

/** Pointer coords packaged like a drop/dragover event (touch cross-panel). */
function syntheticPointerEvent(clientX, clientY) {
  const target = document.elementFromPoint(clientX, clientY) || document.body;
  return {
    clientX,
    clientY,
    target,
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() {},
  };
}

function findTaskPanelAtPoint(clientX, clientY) {
  const hit = document.elementFromPoint(clientX, clientY);
  if (!hit) return null;

  const tasksField = document.getElementById("tasks-field");
  const tasksFieldRoot = document.getElementById("tasks-field-root");
  if (tasksField?.contains(hit) || tasksFieldRoot?.contains(hit)) {
    return {
      blockId: "general",
      listEl: tasksFieldRoot?.querySelector(".tasks-list"),
      anchorEl: tasksField,
    };
  }

  const dayTasks = hit.closest(".day-tasks");
  if (dayTasks) {
    const dayRect = dayTasks.closest(".day-rect");
    const dayName = dayRect?.dataset?.day;
    if (!dayName) return null;
    return {
      blockId: `day:${dayName}`,
      listEl: dayTasks.querySelector(".tasks-list"),
      anchorEl: dayTasks,
    };
  }
  return null;
}

/** Route a touch drop to another task panel (general ↔ daily). */
function tryTouchCrossPanelDrop(clientX, clientY, sourceBlock) {
  const payload = window.__dragTaskPayload;
  if (!payload?.sourceBlock || payload.sourceBlock !== sourceBlock) return false;
  const target = findTaskPanelAtPoint(clientX, clientY);
  if (!target || target.blockId === sourceBlock) return false;
  hideAllTaskDropIndicators();
  window.dispatchEvent(
    new CustomEvent("task-touch-cross-drop", {
      detail: {
        clientX,
        clientY,
        payload,
        targetBlock: target.blockId,
      },
    })
  );
  return true;
}

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
  handle.title = "Drag to move";
  const icon = document.createElement("span");
  icon.className = "task-drag-handle-icon";
  icon.setAttribute("aria-hidden", "true");
  handle.appendChild(icon);
  return handle;
}

/** Highlight CSS var with concrete hex fallback if the palette token is missing. */
function taskHighlightCssVar(color) {
  const c = normalizeTaskColor(color);
  if (!c) return "";
  const token = c.slice(1);
  return `var(--task-hl-${token}, ${c})`;
}

/** Apply / clear the highlight color on a task row element. */
function applyTaskRowColor(row, color) {
  if (!row) return;
  const c = normalizeTaskColor(color);
  if (c) {
    row.dataset.color = c;
    row.style.setProperty("--task-hl", taskHighlightCssVar(c));
    row.style.background = "";
  } else {
    delete row.dataset.color;
    row.style.removeProperty("--task-hl");
    row.style.background = "";
  }
}

function createTaskColorButton() {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "task-color";
  btn.setAttribute("aria-label", "Set task color");
  btn.title = "Color";
  const dot = document.createElement("span");
  dot.className = "task-color-dot";
  dot.setAttribute("aria-hidden", "true");
  btn.appendChild(dot);
  return btn;
}

function createTaskIndentButton(isSubtask) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "task-indent";
  const label = isSubtask ? "Make a regular task" : "Make subtask";
  btn.setAttribute("aria-label", label);
  btn.title = label;
  return btn;
}

function createTaskStarButton(isOn) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `task-star${isOn ? " is-on" : ""}`;
  btn.setAttribute(
    "aria-label",
    isOn ? "Remove as this week’s main thing" : "Set as this week’s main thing"
  );
  btn.title = isOn ? "This week’s main thing" : "Set as this week’s main thing";
  btn.setAttribute("aria-pressed", isOn ? "true" : "false");
  return btn;
}

/** Click target between unchecked and completed rows when the gap is tight. */
function createTasksListAddSpacer() {
  const el = document.createElement("div");
  el.className = "tasks-list-add-spacer";
  el.setAttribute("aria-hidden", "true");
  return el;
}

/** Ensure at least 4em between open and completed tasks, but only when needed. */
function syncTasksListMinGap(listEl) {
  if (!listEl) return;
  const spacer = listEl.querySelector(":scope > .tasks-list-add-spacer");
  if (!spacer) return;

  const anchor = listEl.querySelector(":scope > .task-row.task-row-completed-anchor");
  spacer.style.minHeight = "0";
  if (!anchor) return;

  const lastOpen = spacer.previousElementSibling;
  if (!lastOpen) return;

  const gapPx = anchor.offsetTop - lastOpen.offsetTop - lastOpen.offsetHeight;
  const minGapPx = parseFloat(getComputedStyle(listEl).fontSize) * 4;
  spacer.style.minHeight = gapPx + 0.5 < minGapPx ? "4em" : "0";
}

let tasksListMinGapObserver = null;

function observeTasksListMinGap(listEl) {
  if (!listEl) return;
  if (!tasksListMinGapObserver) {
    tasksListMinGapObserver = new ResizeObserver((entries) => {
      for (const entry of entries) syncTasksListMinGap(entry.target);
    });
  }
  tasksListMinGapObserver.observe(listEl);
  syncTasksListMinGap(listEl);
}

function syncTaskColorButton(btn, color) {
  if (!btn) return;
  const dot = btn.querySelector(".task-color-dot");
  if (!dot) return;
  const c = normalizeTaskColor(color);
  if (c) {
    dot.style.background = taskHighlightCssVar(c);
    dot.dataset.filled = "1";
  } else {
    dot.style.background = "";
    delete dot.dataset.filled;
  }
}

let activeColorPicker = null;
let pendingBlurCommitTimer = null;

/** >0 while a panel re-render is removing its rows. */
let taskListRerendering = 0;

/**
 * Empty a task list container. Chrome fires `blur` on the focused field while
 * it is being removed; blur handlers check `taskListRerendering` to tell that
 * apart from the user leaving the field.
 */
function clearTaskListContainer(el) {
  if (!el) return;
  taskListRerendering += 1;
  try {
    el.innerHTML = "";
  } finally {
    taskListRerendering -= 1;
  }
}

/** Defer blur→commit so mobile tap on action buttons (color, etc.) can cancel it. */
function scheduleTaskBlurCommit(commitFn, shouldSkip) {
  if (pendingBlurCommitTimer != null) {
    clearTimeout(pendingBlurCommitTimer);
  }
  pendingBlurCommitTimer = setTimeout(() => {
    pendingBlurCommitTimer = null;
    if (shouldSkip?.()) return;
    if (activeColorPicker) return;
    if (document.querySelector(".task-color-popover")) return;
    const ae = document.activeElement;
    if (ae?.closest?.(".task-row-actions")) return;
    void commitFn();
  }, 50);
}

document.addEventListener(
  "pointerdown",
  (e) => {
    if (
      e.target.closest?.(".task-row-actions") ||
      e.target.closest?.(".task-color-popover")
    ) {
      if (pendingBlurCommitTimer != null) {
        clearTimeout(pendingBlurCommitTimer);
        pendingBlurCommitTimer = null;
      }
    }
  },
  true
);

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

function syncTaskCheckboxA11y(checkbox, checked) {
  if (!checkbox) return;
  checkbox.setAttribute("role", "checkbox");
  checkbox.setAttribute("aria-checked", checked ? "true" : "false");
  checkbox.setAttribute(
    "aria-label",
    checked ? "Mark task incomplete" : "Mark task complete"
  );
}

function wireTaskColorSwatch(btn, onPick) {
  const pick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    onPick();
    closeTaskColorPicker(true);
  };
  btn.addEventListener("mousedown", pick);
  btn.addEventListener("click", pick);
}

function openTaskColorPicker(anchor, currentColor, onSelect, restoreFocusInput, rowEl) {
  closeTaskColorPicker(false);
  if (!anchor) return;

  const pop = document.createElement("div");
  pop.className = "task-color-popover";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-modal", "true");
  pop.setAttribute("aria-label", "Task color");

  const grid = document.createElement("div");
  grid.className = "task-color-grid";
  grid.setAttribute("role", "listbox");
  grid.setAttribute("aria-label", "Task colors");

  const current = normalizeTaskColor(currentColor);
  const swatches = [];

  const noneBtn = document.createElement("button");
  noneBtn.type = "button";
  noneBtn.className = "task-color-swatch task-color-swatch-none";
  noneBtn.setAttribute("role", "option");
  noneBtn.setAttribute("aria-label", "No color");
  noneBtn.setAttribute("aria-selected", !current ? "true" : "false");
  if (!current) noneBtn.classList.add("task-color-swatch-active");
  wireTaskColorSwatch(noneBtn, () => onSelect(null));
  grid.appendChild(noneBtn);
  swatches.push(noneBtn);

  for (const color of TASK_COLOR_PALETTE) {
    const s = document.createElement("button");
    s.type = "button";
    s.className = "task-color-swatch";
    s.style.background = taskHighlightCssVar(color);
    s.setAttribute("role", "option");
    s.setAttribute("aria-label", `Color ${color}`);
    s.setAttribute("aria-selected", current === color ? "true" : "false");
    if (current === color) s.classList.add("task-color-swatch-active");
    wireTaskColorSwatch(s, () => onSelect(color));
    grid.appendChild(s);
    swatches.push(s);
  }

  pop.appendChild(grid);
  document.body.appendChild(pop);

  function focusSwatch(index) {
    const i = ((index % swatches.length) + swatches.length) % swatches.length;
    swatches[i]?.focus({ preventScroll: true });
  }

  function position() {
    const rect = anchor.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    const margin = 8;
    let top = rect.bottom + 6;
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
    if (e.key === "Escape") {
      closeTaskColorPicker(true);
      return;
    }
    if (!pop.contains(e.target)) return;
    const idx = swatches.indexOf(document.activeElement);
    if (idx === -1) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      focusSwatch(idx + 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      focusSwatch(idx - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusSwatch(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusSwatch(swatches.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      document.activeElement?.click();
    }
  };
  const onScroll = () => position();

  document.addEventListener("mousedown", onOutside, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onScroll, true);

  activeColorPicker = { el: pop, onOutside, onKey, onScroll, restoreFocusInput, rowEl };

  requestAnimationFrame(() => focusSwatch(0));
}

function wireTaskDragHandle(dragHandle, row, isAuthed, onDragStart, onDragEnd, touchReorder) {
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
  let touchPointerId = null;
  let touchTracking = false;
  let touchArmed = false;

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
        if (!row.classList.contains("task-row-dragging") && !touchTracking) {
          endDragInteraction();
        }
      });
    };
    window.addEventListener("mouseup", onPointerUp);
    window.addEventListener("pointerup", onPointerUp);
  };

  const onHandlePointerDown = (e) => {
    // Touch/pen use the pointer path below — avoid double-arming HTML5 drag.
    if (e.pointerType && e.pointerType !== "mouse") return;
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

  // iOS / touch: HTML5 DnD from a handle is unreliable. Drive same-list reorder
  // with Pointer Events; desktop mouse keeps the path above.
  if (touchReorder && typeof touchReorder.commit === "function") {
    const finishTouch = (e, committed) => {
      if (!touchArmed && !touchTracking) return;
      if (touchPointerId != null && e.pointerId !== touchPointerId) return;
      try {
        dragHandle.releasePointerCapture?.(touchPointerId);
      } catch {
        /* already released */
      }
      const wasTracking = touchTracking;
      touchArmed = false;
      touchTracking = false;
      touchPointerId = null;
      // Commit while .task-row-dragging is still on — keeps the portaled
      // mobile actions panel hidden so elementFromPoint hits the list.
      if (wasTracking && committed) {
        touchReorder.commit(e.clientX, e.clientY);
      }
      row.classList.remove("task-row-dragging");
      hideAllTaskDropIndicators();
      onDragEnd();
      endDragInteraction();
    };

    dragHandle.addEventListener(
      "pointerdown",
      (e) => {
        if (!isAuthed) return;
        if (e.pointerType === "mouse") return;
        if (e.button != null && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        touchPointerId = e.pointerId;
        touchArmed = true;
        touchTracking = false;
        beginDragInteraction();
        try {
          dragHandle.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        // Seed drag state (payload / draggedId) without a real dataTransfer.
        const fakeDt = {
          effectAllowed: "move",
          setData() {},
          setDragImage() {},
        };
        onDragStart({ dataTransfer: fakeDt, preventDefault() {}, clientX: e.clientX, clientY: e.clientY });
      },
      true
    );

    dragHandle.addEventListener("pointermove", (e) => {
      if (!touchArmed || e.pointerId !== touchPointerId) return;
      if (!touchTracking) {
        touchTracking = true;
        row.classList.add("task-row-dragging");
      }
      const listEl = touchReorder.getListEl?.();
      const indicator = touchReorder.getIndicator?.();
      const anchor = touchReorder.getAnchorEl?.();
      if (listEl && indicator && anchor) {
        updateTaskDropIndicator(
          anchor,
          indicator,
          listEl,
          e,
          touchReorder.getDraggedId?.() ?? row.dataset.id,
          touchReorder.getTaskIndex
        );
      }
    });

    dragHandle.addEventListener("pointerup", (e) => finishTouch(e, true));
    dragHandle.addEventListener("pointercancel", (e) => finishTouch(e, false));
  }
}

function taskRowInsertBefore(e, row) {
  const rect = row.getBoundingClientRect();
  return e.clientY < rect.top + rect.height / 2;
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
      ensureIndicator().hidden = true;
    },
  };
}

function hideAllTaskDropIndicators() {
  document.querySelectorAll(".task-drop-indicator").forEach((el) => {
    el.hidden = true;
  });
  document.getElementById("main-thing")?.classList.remove("is-drop-target");
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
function showCrossDropIndicator(indicator, listEl, insertAt, tasks) {
  if (!listEl) {
    indicator.hide();
    return;
  }
  const rows = listEl.querySelectorAll(".task-row:not(.task-row-dragging)");
  const visibleIdx = tasks
    ? visibleRowIndexForFlatInsert(tasks, insertAt)
    : insertAt;
  if (visibleIdx >= rows.length) {
    indicator.showAtEnd(listEl);
    return;
  }
  indicator.showBeforeRow(rows[Math.max(0, visibleIdx)]);
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
  if (typeof fields.is_main === "boolean") update.is_main = fields.is_main;
  const { error } = await supabase
    .from("tasks")
    .update(update)
    .eq("id", rowId)
    .eq("user_id", userId);
  if (error) return { ok: false, error };
  return { ok: true, error: null };
}

function persistSubtaskNormalizationFixes(changed, { markTaskDirty, persistTask } = {}) {
  if (!changed?.length || !markTaskDirty || !persistTask) return;
  for (const t of changed) {
    if (!t?.dbId || isTaskEmptyText(t.text)) continue;
    markTaskDirty(t);
    void persistTask(t);
  }
}

function isTabNavigationKey(e) {
  return e.key === "Tab" || e.code === "Tab" || e.keyCode === 9;
}

/** Tab indents; Shift+Tab outdents. Meta/Ctrl+Tab left for the browser. */
function isTaskIndentKey(e) {
  return isTabNavigationKey(e) && !e.metaKey && !e.ctrlKey && !e.altKey;
}

function handleTaskTextTabIndent(e, ctx) {
  const {
    tasks,
    taskId,
    getTaskIndex,
    persistTask,
    markTaskDirty,
    schedulePersistTaskPositions,
    render,
    isTaskEmptyText: isEmpty = isTaskEmptyText,
  } = ctx;
  if (!isTaskIndentKey(e)) return false;
  const idx = getTaskIndex(taskId);
  if (idx === -1) return false;
  const task = tasks[idx];
  const willOutdent = !!e.shiftKey;
  if (willOutdent) {
    if (!task.subtask) return false;
  } else if (!canIndentAsSubtask(tasks, idx)) {
    return false;
  }
  e.preventDefault();
  e.stopImmediatePropagation();
  const input = e.target;
  applyTaskSubtaskIndent(tasks, idx, { outdent: willOutdent });
  const fixed = normalizeSubtaskFlags(tasks);
  persistSubtaskNormalizationFixes(fixed, ctx);
  if (!isEmpty(task.text)) {
    markTaskDirty(task);
    void persistTask(task);
  }
  if (typeof ctx.reorder === "function") ctx.reorder(tasks);
  schedulePersistTaskPositions();
  if (ctx.setFocusAfterRender) {
    ctx.setFocusAfterRender({
      id: task.id,
      start: input.selectionStart,
      end: input.selectionEnd,
    });
  }
  render();
  return true;
}

function applyTaskIndentFromButton(ctx, taskId) {
  const {
    tasks,
    getTaskIndex,
    persistTask,
    markTaskDirty,
    schedulePersistTaskPositions,
    render,
    isTaskEmptyText: isEmpty = isTaskEmptyText,
  } = ctx;
  const idx = getTaskIndex(taskId);
  if (idx === -1) return;
  const task = tasks[idx];
  const changed = applyTaskSubtaskIndent(tasks, idx, { outdent: !!task.subtask });
  if (!changed) return;
  const fixed = normalizeSubtaskFlags(tasks);
  persistSubtaskNormalizationFixes(fixed, ctx);
  if (!isEmpty(task.text)) {
    markTaskDirty(task);
    void persistTask(task);
  }
  if (typeof ctx.reorder === "function") ctx.reorder(tasks);
  schedulePersistTaskPositions();
  if (ctx.setFocusAfterRender) {
    ctx.setFocusAfterRender({ id: task.id });
  }
  render();
}

/**
 * Map a flat-array insert index to a visible-row index (collapsed subtasks are
 * skipped in the DOM but still occupy flat-array slots).
 */
function visibleRowIndexForFlatInsert(tasks, insertAt) {
  if (!tasks?.length) return 0;
  const clamped = Math.max(0, Math.min(insertAt, tasks.length));
  let visibleBefore = 0;
  for (let i = 0; i < clamped; i++) {
    if (!isSubtaskRowHidden(tasks, i)) visibleBefore++;
  }
  if (clamped < tasks.length && isSubtaskRowHidden(tasks, clamped)) {
    for (let i = clamped; i < tasks.length; i++) {
      if (!isSubtaskRowHidden(tasks, i)) return visibleBefore;
    }
  }
  return visibleBefore;
}

function focusTaskRowForEdit(row, preferTarget) {
  if (!row) return;
  if (preferTarget?.classList?.contains("task-text")) {
    preferTarget.focus();
    return;
  }
  const input = row.querySelector(".task-text");
  if (input) input.focus();
}

function isTaskRowActionTarget(e) {
  return (
    e.target.classList?.contains("task-commit") ||
    e.target.classList?.contains("task-delete") ||
    !!e.target.closest?.(".task-color") ||
    !!e.target.closest?.(".task-star") ||
    !!e.target.closest?.(".task-indent") ||
    e.target.classList?.contains("task-drag-handle") ||
    e.target.classList?.contains("task-drag-handle-icon") ||
    !!e.target.closest?.(".task-drag-handle") ||
    !!e.target.closest?.(".task-subtask-toggle-wrap")
  );
}

let pendingTaskDeleteChain = Promise.resolve();

function trackPendingTaskDeletes(promise) {
  pendingTaskDeleteChain = pendingTaskDeleteChain
    .then(() => promise)
    .catch(() => {});
}

async function awaitPendingTaskDeletes() {
  await pendingTaskDeleteChain;
}

async function taskRowExistsInDb(supabase, userId, dbId) {
  if (!supabase || !userId || !dbId) return false;
  const { data, error } = await supabase
    .from("tasks")
    .select("id")
    .eq("id", dbId)
    .eq("user_id", userId)
    .maybeSingle();
  return !error && !!data;
}

/** Relocate cross-panel subtree rows; revert any successful writes on failure. */
async function relocateCrossMoveSubtree(
  supabase,
  userId,
  payload,
  targetRelocate,
  startPosition,
  { normalizeContent } = {}
) {
  const rows = crossMovePayloadRows(payload);
  const sourceRelocate = payload?.sourceRelocate;
  const reverted = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.dbId) continue;
    const content = normalizeContent
      ? normalizeContent(String(row.text ?? ""))
      : String(row.text ?? "");
    const { ok, error } = await supabaseRelocateTaskRow(supabase, userId, row.dbId, {
      type: targetRelocate.type,
      day_name: targetRelocate.day_name ?? null,
      date: targetRelocate.date,
      workspace_id: targetRelocate.workspace_id,
      content,
      completed: !!row.checked,
      is_subtask: !!row.subtask,
      color: normalizeTaskColor(row.color),
      position: startPosition + i,
      is_main: !!(targetRelocate.is_main && i === 0 && !row.subtask),
    });
    if (!ok) {
      for (let j = reverted.length - 1; j >= 0; j--) {
        const prev = reverted[j];
        await supabaseRelocateTaskRow(supabase, userId, prev.dbId, prev.sourceFields);
      }
      return { ok: false, error };
    }
    if (sourceRelocate?.rows) {
      const src =
        sourceRelocate.rows.find((r) => r.dbId === row.dbId) ||
        sourceRelocate.rows[i];
      if (src?.dbId) {
        reverted.push({
          dbId: src.dbId,
          sourceFields: {
            type: sourceRelocate.type,
            day_name: sourceRelocate.day_name ?? null,
            date: sourceRelocate.date,
            workspace_id: sourceRelocate.workspace_id,
            content: src.content ?? String(row.text ?? ""),
            completed: src.completed ?? !!row.checked,
            is_subtask: src.is_subtask ?? !!row.subtask,
            color: normalizeTaskColor(src.color ?? row.color),
            position: src.position ?? startPosition + i,
          },
        });
      }
    }
  }
  return { ok: true, error: null };
}

if (typeof window !== "undefined") {
  window.__crossMoveBackups = window.__crossMoveBackups || new Map();
}

function storeCrossMoveSourceBackup(sourceLocalId, position, snapshots) {
  if (typeof window === "undefined") return;
  window.__crossMoveBackups.set(sourceLocalId, { position, snapshots });
}

function takeCrossMoveSourceBackup(sourceLocalId) {
  if (typeof window === "undefined") return null;
  const backup = window.__crossMoveBackups.get(sourceLocalId);
  window.__crossMoveBackups.delete(sourceLocalId);
  return backup || null;
}

function rollbackCrossMoveOnTarget(state, insertedLocalIds) {
  for (let i = insertedLocalIds.length - 1; i >= 0; i--) {
    const idx = state.tasks.findIndex((t) => t.id === insertedLocalIds[i]);
    if (idx !== -1) state.tasks.splice(idx, 1);
  }
}

function reorderSubtreeFromSameListDrop(tasks, fromId, e, listEl, getTaskIndex) {
  const from = getTaskIndex(fromId);
  if (from === -1) return null;

  const row = e.target.closest?.(".task-row");
  if (
    row &&
    listEl?.contains(row) &&
    !row.classList.contains("task-row-dragging") &&
    row.dataset.id &&
    row.dataset.id !== fromId
  ) {
    const to = getTaskIndex(row.dataset.id);
    if (to === -1) return null;
    return reorderSubtreeInArray(tasks, from, to, taskRowInsertBefore(e, row));
  }

  return reorderSubtreeToListEnd(tasks, from);
}

/** Touch pointer drop: resolve target row under the finger (or end of list). */
function reorderSubtreeFromTouchPoint(tasks, fromId, clientX, clientY, listEl, getTaskIndex) {
  const from = getTaskIndex(fromId);
  if (from === -1) return null;
  const hit = document.elementFromPoint(clientX, clientY);
  const row = hit?.closest?.(".task-row");
  if (
    row &&
    listEl?.contains(row) &&
    !row.classList.contains("task-row-dragging") &&
    row.dataset.id &&
    row.dataset.id !== fromId
  ) {
    const to = getTaskIndex(row.dataset.id);
    if (to === -1) return null;
    return reorderSubtreeInArray(
      tasks,
      from,
      to,
      taskRowInsertBefore({ clientY }, row)
    );
  }
  return reorderSubtreeToListEnd(tasks, from);
}

const collapsedSubtaskParents = new Set();

function collapseKeyForTask(task) {
  if (!task) return null;
  if (task.dbId != null) return `db:${task.dbId}`;
  return `local:${task.id}`;
}

function isTaskCollapsed(task) {
  const key = collapseKeyForTask(task);
  return key != null && collapsedSubtaskParents.has(key);
}

function setTaskCollapsed(task, collapsed) {
  const key = collapseKeyForTask(task);
  if (!key) return;
  if (collapsed) collapsedSubtaskParents.add(key);
  else collapsedSubtaskParents.delete(key);
}

function collapsedSubtasksStorageKey(workspaceId) {
  return `oneweek-collapsed-subs-${workspaceId || "none"}`;
}

function readCollapsedSubtaskDbIds(workspaceId) {
  try {
    const raw = localStorage.getItem(collapsedSubtasksStorageKey(workspaceId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.map(String).filter(Boolean));
  } catch {
    return new Set();
  }
}

function writeCollapsedSubtaskDbIds(workspaceId, dbIds) {
  if (!workspaceId) return;
  try {
    const key = collapsedSubtasksStorageKey(workspaceId);
    if (!dbIds || dbIds.size === 0) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, JSON.stringify([...dbIds]));
  } catch {
    /* storage blocked */
  }
}

/** Restore collapse UI state from persisted parent dbIds for this workspace. */
function syncCollapsedSubtasksFromStorage(tasks, workspaceId) {
  if (!tasks?.length) return;
  const dbIds = workspaceId ? readCollapsedSubtaskDbIds(workspaceId) : new Set();
  for (const t of tasks) {
    if (!t || t.subtask) continue;
    const key = collapseKeyForTask(t);
    if (!key || t.dbId == null) continue;
    if (dbIds.has(String(t.dbId))) collapsedSubtaskParents.add(key);
    else collapsedSubtaskParents.delete(key);
  }
}

/** Drop collapse entries for deleted mains and stale dbIds no longer on the board. */
function pruneCollapsedSubtaskStorage(tasks, removedTasks, workspaceId) {
  if (!workspaceId) return;
  const existing = readCollapsedSubtaskDbIds(workspaceId);
  let changed = false;

  for (const t of removedTasks || []) {
    if (!t || t.subtask || t.dbId == null) continue;
    const dbKey = String(t.dbId);
    if (existing.has(dbKey)) {
      existing.delete(dbKey);
      changed = true;
    }
    collapsedSubtaskParents.delete(collapseKeyForTask(t));
  }

  const liveDbIds = new Set(
    (tasks || [])
      .filter((t) => !t.subtask && t.dbId != null)
      .map((t) => String(t.dbId))
  );
  for (const dbKey of existing) {
    if (!liveDbIds.has(dbKey)) {
      existing.delete(dbKey);
      changed = true;
    }
  }

  if (changed) writeCollapsedSubtaskDbIds(workspaceId, existing);
}

/** Persist collapse for the given panel's tasks (merge into workspace store). */
function persistCollapsedSubtasksToStorage(tasks, workspaceId) {
  if (!workspaceId || !tasks) return;
  const existing = readCollapsedSubtaskDbIds(workspaceId);
  for (const t of tasks) {
    if (!t || t.subtask || t.dbId == null) continue;
    const key = String(t.dbId);
    if (isTaskCollapsed(t)) existing.add(key);
    else existing.delete(key);
  }
  writeCollapsedSubtaskDbIds(workspaceId, existing);
}

function isSubtaskRowHidden(tasks, idx) {
  const task = tasks[idx];
  if (!task?.subtask) return false;
  const parentIdx = getParentMainTaskIndex(tasks, idx);
  if (parentIdx < 0) return false;
  return isTaskCollapsed(tasks[parentIdx]);
}

function createSubtaskToggle(mainTask, subtaskCount, onToggle) {
  const wrap = document.createElement("div");
  wrap.className = "task-subtask-toggle-wrap";

  const countEl = document.createElement("span");
  countEl.className = "task-subtask-count";
  countEl.textContent = String(subtaskCount);
  countEl.setAttribute("aria-hidden", "true");

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "task-subtask-toggle";
  const collapseKey = collapseKeyForTask(mainTask);
  const collapsed = collapseKey != null && collapsedSubtaskParents.has(collapseKey);
  if (collapsed) {
    btn.classList.add("is-collapsed");
    wrap.classList.add("is-collapsed");
  }
  btn.setAttribute(
    "aria-label",
    collapsed
      ? `Show ${subtaskCount} subtask${subtaskCount === 1 ? "" : "s"}`
      : "Hide subtasks"
  );
  btn.setAttribute("aria-expanded", String(!collapsed));
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!collapseKey) return;
    if (collapsedSubtaskParents.has(collapseKey)) {
      collapsedSubtaskParents.delete(collapseKey);
    } else {
      collapsedSubtaskParents.add(collapseKey);
    }
    onToggle();
  });

  wrap.appendChild(countEl);
  wrap.appendChild(btn);
  return wrap;
}

/**
 * Mobile-only: portal .task-row-actions to document.body and place it with
 * position:absolute in *document* coordinates (rect + scroll offset). Unlike
 * position:fixed, it scrolls with the task automatically — no scroll listener.
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
    ".task-row:has(.task-star:focus)",
    ".task-row:has(.task-indent:focus)",
    ".task-row:has(.task-drag-handle:focus)",
    ".task-row.task-row-reorder-active",
    ".task-row.task-row-color-open",
  ].join(", ");

  const portaledPanelByRow = new WeakMap();
  const rowByPortaledPanel = new WeakMap();
  let observedRow = null;
  const rowResizeObserver = new ResizeObserver(() => scheduleUpdate());

  function isMobile() {
    return MOBILE_MEDIA ? MOBILE_MEDIA.matches : false;
  }

  function clearPanelStyles(panel) {
    panel.style.top = "";
    panel.style.left = "";
    panel.style.width = "";
    panel.style.right = "";
    panel.style.bottom = "";
  }

  function unportalPanel(panel) {
    if (!panel) return;
    panel.classList.remove("is-mobile-portaled");
    clearPanelStyles(panel);
    const row = rowByPortaledPanel.get(panel);
    rowByPortaledPanel.delete(panel);
    if (row) portaledPanelByRow.delete(row);
    if (panel.parentNode === document.body) {
      if (row?.isConnected) row.appendChild(panel);
      else panel.remove();
    }
  }

  function unportalAllPanels() {
    document.body.querySelectorAll(":scope > .task-row-actions").forEach(unportalPanel);
  }

  function getActionsPanel(row) {
    if (!row) return null;
    return portaledPanelByRow.get(row) || row.querySelector(":scope > .task-row-actions");
  }

  function portalPanel(panel, row) {
    portaledPanelByRow.set(row, panel);
    rowByPortaledPanel.set(panel, row);
    panel.classList.add("is-mobile-portaled");
    if (panel.parentNode !== document.body) document.body.appendChild(panel);
  }

  function positionPanel(panel, row) {
    const scrollX = window.scrollX || 0;
    const scrollY = window.scrollY || 0;
    const rect = row.getBoundingClientRect();
    // Natural width (buttons stay thumb-sized even in a narrow day cell),
    // aligned with the row but kept inside the viewport.
    const margin = 8;
    const viewportWidth = document.documentElement.clientWidth;
    const left = Math.max(
      margin,
      Math.min(rect.left, viewportWidth - panel.offsetWidth - margin)
    );
    panel.style.left = `${left + scrollX}px`;
    panel.style.width = "";
    panel.style.right = "auto";
    if (row.classList.contains("completed")) {
      const panelHeight = panel.offsetHeight;
      panel.style.top = `${rect.top + scrollY - panelHeight - 6}px`;
    } else {
      panel.style.top = `${rect.bottom + scrollY + 6}px`;
    }
    panel.style.bottom = "auto";
  }

  function update() {
    if (!isMobile()) {
      unportalAllPanels();
      rowResizeObserver.disconnect();
      observedRow = null;
      return;
    }

    const row = document.querySelector(ACTIVE_ROW_SELECTOR);

    document.body.querySelectorAll(":scope > .task-row-actions").forEach((panel) => {
      const ownerRow = rowByPortaledPanel.get(panel);
      if (!ownerRow?.isConnected || ownerRow !== row) unportalPanel(panel);
    });

    if (!row) {
      rowResizeObserver.disconnect();
      observedRow = null;
      return;
    }

    if (observedRow !== row) {
      rowResizeObserver.disconnect();
      rowResizeObserver.observe(row);
      observedRow = row;
    }

    const panel = getActionsPanel(row);
    if (!panel) return;

    portalPanel(panel, row);
    positionPanel(panel, row);
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
  document.addEventListener("input", (e) => {
    if (e.target?.classList?.contains("task-text")) scheduleUpdate();
  });
  window.addEventListener("resize", scheduleUpdate);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", scheduleUpdate);
  }
  if (MOBILE_MEDIA?.addEventListener) {
    MOBILE_MEDIA.addEventListener("change", scheduleUpdate);
  }

  const classObserver = new MutationObserver(scheduleUpdate);
  classObserver.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ["class"],
  });

  scheduleUpdate();
})();
