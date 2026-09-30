/**
 * Settings sidebar — open/close + focus trap, account status and logout,
 * and the theme picker (presets, "Match device", custom themes, color picker).
 */

window.addEventListener("load", () => {
  const overlay = document.getElementById("auth-overlay");
  const authTriggers = document.querySelectorAll("#auth-trigger-mobile");
  const closeBtn = document.getElementById("auth-close");
  const openSignInBtn = document.getElementById("auth-open-signin");
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
    if (openSignInBtn) openSignInBtn.disabled = isPending;
    if (logoutBtn) logoutBtn.disabled = isPending;
  }

  async function runAuthAction(pendingText, actionFn, successText) {
    setAuthPending(true);
    setAuthMessage(pendingText);
    const res = await actionFn();
    setAuthPending(false);
    if (res?.cancelled) {
      setAuthMessage("");
      return false;
    }
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

  window.oneweekAuth.subscribe(() => {
    void refreshAuthStatus();
  });

  const themeInputText = document.getElementById("theme-color-text");
  const themeInputBg = document.getElementById("theme-color-background");
  const themeFontSelect = document.getElementById("theme-font");
  const themeApplyBtn = document.getElementById("theme-apply");
  const themeSelect = document.getElementById("theme-select");
  const themeCustomFields = document.getElementById("theme-custom-fields");
  const themeDeleteBtn = document.getElementById("theme-delete");
  const themeCustomName = document.getElementById("theme-custom-name");

  let editingCustomThemeId = null;
  const DEFAULT_THEME_KEY = window.oneweekTheme?.DEFAULT_THEME_KEY || "auto";

  function getThemePresets() {
    return themeApi()?.PRESETS || {};
  }

  function themeApi() {
    return window.oneweekTheme;
  }

  function getSelectedThemeKey() {
    return themeApi()?.getSelectedThemeKey() ?? DEFAULT_THEME_KEY;
  }

  function setSelectedThemeKey(key) {
    themeApi()?.setSelectedThemeKey(key);
  }

  function customThemeLabel(theme) {
    return theme.name || `Custom (${theme.text} / ${theme.bg})`;
  }

  function buildThemeFontOptions() {
    const tw = window.oneweekTheme;
    if (!themeFontSelect || !tw?.GOOGLE_FONTS) return;
    themeFontSelect.innerHTML = "";
    for (const font of tw.GOOGLE_FONTS) {
      const opt = document.createElement("option");
      opt.value = font.id;
      opt.textContent = font.label;
      themeFontSelect.appendChild(opt);
    }
  }

  function buildThemeOptions() {
    if (!themeSelect) return;
    const tw = themeApi();
    themeSelect.innerHTML = "";
    const autoOpt = document.createElement("option");
    autoOpt.value = tw?.AUTO_THEME_KEY || "auto";
    autoOpt.textContent = "Match device";
    themeSelect.appendChild(autoOpt);
    for (const [key, preset] of Object.entries(getThemePresets())) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = preset.label || key;
      themeSelect.appendChild(opt);
    }
    const customs = tw ? tw.getCustomThemes() : [];
    for (const theme of customs) {
      const opt = document.createElement("option");
      opt.value = tw.customThemeSelectKey(theme.id);
      opt.textContent = customThemeLabel(theme);
      themeSelect.appendChild(opt);
    }
    const ownOpt = document.createElement("option");
    ownOpt.value = "own";
    ownOpt.textContent = "Own...";
    themeSelect.appendChild(ownOpt);
  }

  const themeDeleteActions = themeDeleteBtn
    ? themeDeleteBtn.closest(".sidebar-actions")
    : null;

  function updateThemeDeleteVisibility(key) {
    const tw = themeApi();
    const resolvedKey = themeSelect?.value || key;
    const show =
      !!tw &&
      tw.isCustomThemeKey(resolvedKey) &&
      !!tw.findCustomTheme(tw.customThemeIdFromKey(resolvedKey));
    if (themeDeleteBtn) themeDeleteBtn.hidden = !show;
    if (themeDeleteActions) themeDeleteActions.hidden = !show;
  }

  function applyThemeByKey(key) {
    const tw = themeApi();
    if (!tw) return;
    tw.applyThemeKey(key);
    setSelectedThemeKey(key);
  }

  function fillThemeFormFromTheme(theme) {
    const tw = themeApi();
    if (!tw || !themeInputText || !themeInputBg) return;
    themeInputText.value = theme.text;
    themeInputBg.value = theme.bg;
    if (themeCustomName) themeCustomName.value = theme.name || "";
    if (themeFontSelect) themeFontSelect.value = theme.fontId || "";
    tw.applyThemeToDocument(theme.text, theme.bg, theme.fontId || "");
  }

  function fillThemeFormForOwnMode(previousKey) {
    const tw = themeApi();
    if (!tw) return;
    if (tw.isCustomThemeKey(previousKey)) {
      const id = tw.customThemeIdFromKey(previousKey);
      const theme = tw.findCustomTheme(id);
      if (theme) {
        editingCustomThemeId = id;
        fillThemeFormFromTheme(theme);
        return;
      }
    }
    editingCustomThemeId = null;
    if (themeCustomName) themeCustomName.value = "";
    syncThemeInputs();
  }

  function syncThemeInputs() {
    const tw = themeApi();
    if (!tw || !themeInputText || !themeInputBg) return;
    themeInputText.value = tw.getCurrentHexForInput(
      "--color-text",
      tw.THEME_STORAGE_TEXT,
      tw.DEFAULT_TEXT
    );
    themeInputBg.value = tw.getCurrentHexForInput(
      "--color-background",
      tw.THEME_STORAGE_BG,
      tw.DEFAULT_BG
    );
    if (themeFontSelect) {
      themeFontSelect.value = tw.getStoredCustomFontId();
    }
  }

  function resolveThemeKey(key) {
    return themeApi()?.isKnownThemeKey(key) ? key : DEFAULT_THEME_KEY;
  }

  function syncThemeSelect() {
    if (!themeSelect) return;
    const tw = themeApi();
    let key = resolveThemeKey(getSelectedThemeKey());
    const stored = getSelectedThemeKey();
    if (key !== stored) {
      setSelectedThemeKey(key);
    }
    buildThemeOptions();
    themeSelect.value = key;
    if (!themeSelect.value) {
      key = DEFAULT_THEME_KEY;
      themeSelect.value = key;
      setSelectedThemeKey(key);
    }
    if (themeCustomFields) themeCustomFields.hidden = key !== "own";
    if (key !== "own") editingCustomThemeId = null;
    updateThemeDeleteVisibility(themeSelect.value || key);
    if (key === "own") fillThemeFormForOwnMode(getSelectedThemeKey());
    else syncThemeInputs();
  }

  const sidebar = document.getElementById("sidebar");
  let authPopupReturnFocus = null;

  function getSidebarFocusables() {
    if (!sidebar || sidebar.hidden) return [];
    return [...sidebar.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )].filter((el) => el.offsetParent !== null);
  }

  function trapSidebarFocus(e) {
    if (!sidebar || sidebar.hidden) return;
    if (e.key !== "Tab") return;
    const focusables = getSidebarFocusables();
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function onSidebarKeydown(e) {
    if (!sidebar || sidebar.hidden) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeAuthPopup();
    }
  }

  function openAuthPopup() {
    if (!overlay || !sidebar) return;
    authPopupReturnFocus = document.activeElement;
    overlay.hidden = false;
    sidebar.hidden = false;
    sidebar.setAttribute("aria-modal", "true");
    sidebar.setAttribute("role", "dialog");
    setAuthMessage("");
    syncThemeSelect();
    void refreshAuthStatus();
    const focusables = getSidebarFocusables();
    const toFocus =
      closeBtn && focusables.includes(closeBtn) ? closeBtn : focusables[0];
    if (toFocus) toFocus.focus();
  }

  function closeAuthPopup() {
    if (!overlay || !sidebar) return;
    overlay.hidden = true;
    sidebar.hidden = true;
    sidebar.removeAttribute("aria-modal");
    sidebar.removeAttribute("role");
    const returnTo = authPopupReturnFocus;
    authPopupReturnFocus = null;
    if (returnTo && typeof returnTo.focus === "function") returnTo.focus();
  }

  authTriggers.forEach((btn) => {
    if (btn) btn.addEventListener("click", openAuthPopup);
  });
  if (closeBtn) closeBtn.addEventListener("click", closeAuthPopup);

  if (overlay) {
    overlay.addEventListener("click", closeAuthPopup);
  }

  document.addEventListener("keydown", onSidebarKeydown);
  if (sidebar) sidebar.addEventListener("keydown", trapSidebarFocus);

  if (openSignInBtn) {
    openSignInBtn.addEventListener("click", () => {
      closeAuthPopup();
      if (typeof window.oneweekOpenGuestAuth === "function") {
        window.oneweekOpenGuestAuth();
      }
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
        fillThemeFormForOwnMode(getSelectedThemeKey());
        updateThemeDeleteVisibility(key);
        setSelectedThemeKey("own");
        return;
      }
      editingCustomThemeId = null;
      if (themeCustomFields) themeCustomFields.hidden = true;
      updateThemeDeleteVisibility(key);
      applyThemeByKey(key);
    });
  }

  function previewCustomTheme() {
    const tw = window.oneweekTheme;
    if (!tw || !themeInputText || !themeInputBg) return;
    const nt = tw.normalizeHexColor(themeInputText.value);
    const nb = tw.normalizeHexColor(themeInputBg.value);
    const fontId = themeFontSelect ? themeFontSelect.value : "";
    if (nt && nb) {
      tw.applyThemeToDocument(nt, nb, fontId);
    }
  }

  if (themeInputText) themeInputText.addEventListener("input", previewCustomTheme);
  if (themeInputBg) themeInputBg.addEventListener("input", previewCustomTheme);
  if (themeFontSelect) themeFontSelect.addEventListener("change", previewCustomTheme);

  (function setupThemeColorPicker() {
    const picker = document.getElementById("theme-color-picker");
    const svEl = document.getElementById("theme-color-sv");
    const svCursor = document.getElementById("theme-color-sv-cursor");
    const hueEl = document.getElementById("theme-color-hue");
    const hueCursor = document.getElementById("theme-color-hue-cursor");
    const eyedropperBtn = document.getElementById("theme-color-eyedropper");
    const swatches = document.querySelectorAll(".theme-color-swatch[data-theme-color-for]");
    if (!picker || !svEl || !hueEl || !themeInputText || !themeInputBg) return;

    const hsv = { h: 0, s: 0, v: 1 };
    let activeInput = null;
    let dragging = null;

    function clamp(n, min, max) {
      return Math.min(max, Math.max(min, n));
    }

    function hexToRgb(hex) {
      const n = themeApi()?.normalizeHexColor(hex);
      if (!n) return null;
      return {
        r: parseInt(n.slice(1, 3), 16),
        g: parseInt(n.slice(3, 5), 16),
        b: parseInt(n.slice(5, 7), 16),
      };
    }

    function rgbToHex(r, g, b) {
      const to = (c) => clamp(Math.round(c), 0, 255).toString(16).padStart(2, "0");
      return `#${to(r)}${to(g)}${to(b)}`;
    }

    function rgbToHsv(r, g, b) {
      r /= 255;
      g /= 255;
      b /= 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const d = max - min;
      let h = 0;
      if (d !== 0) {
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
      }
      return { h, s: max === 0 ? 0 : d / max, v: max };
    }

    function hsvToRgb(h, s, v) {
      const c = v * s;
      const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
      const m = v - c;
      let r = 0;
      let g = 0;
      let b = 0;
      if (h < 60) {
        r = c;
        g = x;
      } else if (h < 120) {
        r = x;
        g = c;
      } else if (h < 180) {
        g = c;
        b = x;
      } else if (h < 240) {
        g = x;
        b = c;
      } else if (h < 300) {
        r = x;
        b = c;
      } else {
        r = c;
        b = x;
      }
      return {
        r: (r + m) * 255,
        g: (g + m) * 255,
        b: (b + m) * 255,
      };
    }

    function hsvToHex(h, s, v) {
      const rgb = hsvToRgb(h, s, v);
      return rgbToHex(rgb.r, rgb.g, rgb.b);
    }

    function hueHex(h) {
      return hsvToHex(h, 1, 1);
    }

    function inputForSwatch(swatch) {
      return document.getElementById(swatch.dataset.themeColorFor || "");
    }

    function syncThemeColorSwatches() {
      swatches.forEach((swatch) => {
        const input = inputForSwatch(swatch);
        const hex = themeApi()?.normalizeHexColor(input?.value || "");
        swatch.style.background = hex || "transparent";
      });
    }

    function paintPicker() {
      picker.style.setProperty("--theme-picker-hue", hueHex(hsv.h));
      const svRect = svEl.getBoundingClientRect();
      const hueRect = hueEl.getBoundingClientRect();
      if (svCursor && svRect.width && svRect.height) {
        svCursor.style.left = `${hsv.s * 100}%`;
        svCursor.style.top = `${(1 - hsv.v) * 100}%`;
        svCursor.style.background = hsvToHex(hsv.h, hsv.s, hsv.v);
      }
      if (hueCursor && hueRect.width) {
        hueCursor.style.left = `${(hsv.h / 360) * 100}%`;
      }
    }

    function applyHsvToInput() {
      if (!activeInput) return;
      activeInput.value = hsvToHex(hsv.h, hsv.s, hsv.v);
      activeInput.dispatchEvent(new Event("input", { bubbles: true }));
      paintPicker();
    }

    function loadFromInput(input) {
      const rgb = hexToRgb(input?.value || "") || { r: 255, g: 255, b: 255 };
      const next = rgbToHsv(rgb.r, rgb.g, rgb.b);
      hsv.h = next.h;
      hsv.s = next.s;
      hsv.v = next.v;
      paintPicker();
    }

    function positionPicker(anchor) {
      const margin = 8;
      const rect = anchor.getBoundingClientRect();
      picker.hidden = false;
      const pop = picker.getBoundingClientRect();
      let top = rect.bottom + 6;
      let left = rect.left;
      if (top + pop.height > window.innerHeight - margin) {
        top = Math.max(margin, rect.top - pop.height - 6);
      }
      if (left + pop.width > window.innerWidth - margin) {
        left = Math.max(margin, window.innerWidth - pop.width - margin);
      }
      picker.style.top = `${top}px`;
      picker.style.left = `${left}px`;
    }

    function closePicker() {
      if (picker.hidden) return;
      picker.hidden = true;
      swatches.forEach((s) => s.setAttribute("aria-expanded", "false"));
      activeInput = null;
      dragging = null;
    }

    function openPicker(swatch) {
      const input = inputForSwatch(swatch);
      if (!input) return;
      if (activeInput === input && !picker.hidden) {
        closePicker();
        return;
      }
      activeInput = input;
      swatches.forEach((s) =>
        s.setAttribute("aria-expanded", String(s === swatch))
      );
      loadFromInput(input);
      positionPicker(swatch);
    }

    function svFromPointer(e) {
      const rect = svEl.getBoundingClientRect();
      hsv.s = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      hsv.v = clamp(1 - (e.clientY - rect.top) / rect.height, 0, 1);
      applyHsvToInput();
    }

    function hueFromPointer(e) {
      const rect = hueEl.getBoundingClientRect();
      hsv.h = clamp(((e.clientX - rect.left) / rect.width) * 360, 0, 359.99);
      applyHsvToInput();
    }

    svEl.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      svEl.setPointerCapture(e.pointerId);
      dragging = "sv";
      svFromPointer(e);
    });
    hueEl.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      hueEl.setPointerCapture(e.pointerId);
      dragging = "hue";
      hueFromPointer(e);
    });
    const onPointerMove = (e) => {
      if (dragging === "sv") svFromPointer(e);
      else if (dragging === "hue") hueFromPointer(e);
    };
    const onPointerUp = () => {
      dragging = null;
    };
    svEl.addEventListener("pointermove", onPointerMove);
    hueEl.addEventListener("pointermove", onPointerMove);
    svEl.addEventListener("pointerup", onPointerUp);
    hueEl.addEventListener("pointerup", onPointerUp);
    svEl.addEventListener("pointercancel", onPointerUp);
    hueEl.addEventListener("pointercancel", onPointerUp);

    swatches.forEach((swatch) => {
      swatch.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openPicker(swatch);
      });
    });

    themeInputText.addEventListener("input", () => {
      syncThemeColorSwatches();
      if (activeInput === themeInputText && !picker.hidden && !dragging) {
        loadFromInput(themeInputText);
      }
    });
    themeInputBg.addEventListener("input", () => {
      syncThemeColorSwatches();
      if (activeInput === themeInputBg && !picker.hidden && !dragging) {
        loadFromInput(themeInputBg);
      }
    });

    if (eyedropperBtn) {
      if (!window.EyeDropper) {
        eyedropperBtn.hidden = true;
      } else {
        eyedropperBtn.addEventListener("click", async (e) => {
          e.preventDefault();
          e.stopPropagation();
          try {
            const result = await new window.EyeDropper().open();
            const hex = themeApi()?.normalizeHexColor(result?.sRGBHex || "");
            if (!hex || !activeInput) return;
            activeInput.value = hex;
            activeInput.dispatchEvent(new Event("input", { bubbles: true }));
            loadFromInput(activeInput);
          } catch (_) {
            /* user cancelled */
          }
        });
      }
    }

    document.addEventListener("mousedown", (e) => {
      if (picker.hidden) return;
      if (picker.contains(e.target)) return;
      if (e.target.closest?.(".theme-color-swatch")) return;
      closePicker();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closePicker();
    });
    window.addEventListener("resize", closePicker);

    const originalFill = fillThemeFormFromTheme;
    fillThemeFormFromTheme = function (theme) {
      originalFill(theme);
      syncThemeColorSwatches();
      if (!picker.hidden && activeInput) loadFromInput(activeInput);
    };
    const originalSync = syncThemeInputs;
    syncThemeInputs = function () {
      originalSync();
      syncThemeColorSwatches();
      if (!picker.hidden && activeInput) loadFromInput(activeInput);
    };

    const sidebarEl = document.getElementById("sidebar");
    const fieldsObserver = new MutationObserver(() => {
      if (themeCustomFields?.hidden || sidebarEl?.hidden) closePicker();
    });
    if (themeCustomFields) {
      fieldsObserver.observe(themeCustomFields, {
        attributes: true,
        attributeFilter: ["hidden"],
      });
    }
    if (sidebarEl) {
      fieldsObserver.observe(sidebarEl, {
        attributes: true,
        attributeFilter: ["hidden"],
      });
    }

    syncThemeColorSwatches();
  })();

  if (themeApplyBtn) {
    themeApplyBtn.addEventListener("click", () => {
      const tw = themeApi();
      if (!tw || !themeInputText || !themeInputBg) return;
      const nt = tw.normalizeHexColor(themeInputText.value);
      const nb = tw.normalizeHexColor(themeInputBg.value);
      if (!nt || !nb) {
        setAuthMessage("Please enter colors in #RGB or #RRGGBB format.", true);
        return;
      }
      const name = (themeCustomName ? themeCustomName.value.trim() : "") || "";
      const fontId = themeFontSelect ? themeFontSelect.value : "";
      const id = editingCustomThemeId || tw.generateThemeId();
      const existing = tw.findCustomTheme(id);
      const saved = { id, name, text: nt, bg: nb, fontId };
      const themes = tw
        .getCustomThemes()
        .filter((t) => t.id !== id)
        .concat(saved);
      tw.saveCustomThemes(themes);
      const selectKey = tw.customThemeSelectKey(id);
      tw.applyThemeKey(selectKey);
      try {
        localStorage.setItem(tw.THEME_CUSTOM_FONT_KEY, fontId);
      } catch (_) {}
      setSelectedThemeKey(selectKey);
      editingCustomThemeId = null;
      buildThemeOptions();
      themeSelect.value = selectKey;
      if (themeCustomFields) themeCustomFields.hidden = true;
      updateThemeDeleteVisibility(selectKey);
      setAuthMessage(
        existing ? "Custom theme updated." : "Custom theme saved.",
        false
      );
    });
  }

  if (themeDeleteBtn) {
    themeDeleteBtn.addEventListener("click", () => {
      const tw = themeApi();
      if (!tw || !themeSelect) return;
      const key = themeSelect.value;
      if (!tw.isCustomThemeKey(key)) return;
      const id = tw.customThemeIdFromKey(key);
      tw.saveCustomThemes(tw.getCustomThemes().filter((t) => t.id !== id));
      editingCustomThemeId = null;
      applyThemeByKey(DEFAULT_THEME_KEY);
      syncThemeSelect();
      setAuthMessage("Custom theme deleted.", false);
    });
  }

  buildThemeFontOptions();
  syncThemeSelect();

  // Theme settings synced from another device: refresh the picker unless the
  // user is mid-edit in "Own..." (theme-init leaves that draft untouched).
  window.addEventListener(themeApi()?.THEME_REMOTE_CHANGE || "oneweek-theme-remote-change", () => {
    if (getSelectedThemeKey() === "own") {
      buildThemeOptions();
      themeSelect.value = "own";
      return;
    }
    syncThemeSelect();
  });
});
