(function () {
  const THEME_STORAGE_TEXT = "oneweek-theme-color-text";
  const THEME_STORAGE_BG = "oneweek-theme-color-background";
  const DEFAULT_TEXT = "#000000";
  const DEFAULT_BG = "#ffffff";

  function normalizeHexColor(raw) {
    const s = String(raw ?? "").trim();
    if (!s) return "";
    const v = s.startsWith("#") ? s : `#${s}`;
    if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) return "";
    if (v.length === 4) {
      const r = v[1];
      const g = v[2];
      const b = v[3];
      return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
    }
    return v.toLowerCase();
  }

  function applyThemeToDocument(textHex, bgHex) {
    const root = document.documentElement;
    if (textHex) root.style.setProperty("--color-text", textHex);
    else root.style.removeProperty("--color-text");
    if (bgHex) root.style.setProperty("--color-background", bgHex);
    else root.style.removeProperty("--color-background");
  }

  const PRESETS = {
    light: { text: "#000000", bg: "#ffffff" },
    dark: { text: "#ffffff", bg: "#000000" },
  };

  function initThemeFromStorage() {
    try {
      const selected = localStorage.getItem("oneweek-theme-selected") || "light";
      if (selected === "custom") {
        const ct = localStorage.getItem("oneweek-custom-text");
        const cb = localStorage.getItem("oneweek-custom-bg");
        if (ct && cb) {
          applyThemeToDocument(normalizeHexColor(ct), normalizeHexColor(cb));
          return;
        }
      }
      if (PRESETS[selected]) {
        applyThemeToDocument(PRESETS[selected].text, PRESETS[selected].bg);
        return;
      }
      const t = localStorage.getItem(THEME_STORAGE_TEXT);
      const b = localStorage.getItem(THEME_STORAGE_BG);
      const nt = t ? normalizeHexColor(t) : "";
      const nb = b ? normalizeHexColor(b) : "";
      if (t && !nt) localStorage.removeItem(THEME_STORAGE_TEXT);
      if (b && !nb) localStorage.removeItem(THEME_STORAGE_BG);
      applyThemeToDocument(nt, nb);
    } catch (_) {
      /* ignore */
    }
  }

  function persistTheme(textHex, bgHex) {
    try {
      if (textHex) localStorage.setItem(THEME_STORAGE_TEXT, textHex);
      else localStorage.removeItem(THEME_STORAGE_TEXT);
      if (bgHex) localStorage.setItem(THEME_STORAGE_BG, bgHex);
      else localStorage.removeItem(THEME_STORAGE_BG);
    } catch (_) {
      /* ignore */
    }
  }

  function getCurrentHexForInput(cssVarName, storageKey, fallbackHex) {
    const inline = document.documentElement.style.getPropertyValue(cssVarName).trim();
    const n0 = normalizeHexColor(inline);
    if (n0) return n0;
    try {
      const raw = localStorage.getItem(storageKey);
      const n1 = normalizeHexColor(raw || "");
      if (n1) return n1;
    } catch (_) {
      /* ignore */
    }
    if (typeof getComputedStyle === "function") {
      const computed = getComputedStyle(document.documentElement)
        .getPropertyValue(cssVarName)
        .trim();
      const n2 = normalizeHexColor(computed);
      if (n2) return n2;
    }
    return fallbackHex;
  }

  initThemeFromStorage();

  window.oneweekTheme = {
    THEME_STORAGE_TEXT,
    THEME_STORAGE_BG,
    DEFAULT_TEXT,
    DEFAULT_BG,
    normalizeHexColor,
    applyThemeToDocument,
    initThemeFromStorage,
    persistTheme,
    getCurrentHexForInput,
  };
})();
