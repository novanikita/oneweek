(function () {
  const THEME_STORAGE_TEXT = "oneweek-theme-color-text";
  const THEME_STORAGE_BG = "oneweek-theme-color-background";
  const THEME_CUSTOM_FONT_KEY = "oneweek-custom-font";
  const THEME_CUSTOM_THEMES_KEY = "oneweek-custom-themes";
  const THEME_SELECTED_KEY = "oneweek-theme-selected";
  /** When the user last changed the theme choice here (ISO); sync compares it. */
  const THEME_UPDATED_AT_KEY = "oneweek-theme-updated-at";
  const DEFAULT_TEXT = "#000000";
  const DEFAULT_BG = "#ffffff";
  const DEFAULT_FONT_STACK = '"Proto Grotesk", system-ui, sans-serif';

  /** "Match device": follows the OS light/dark setting. */
  const AUTO_THEME_KEY = "auto";
  const AUTO_LIGHT_PRESET = "native-light";
  const AUTO_DARK_PRESET = "native-dark";
  /** Theme for devices that never picked one. */
  const DEFAULT_THEME_KEY = AUTO_THEME_KEY;
  /** Unsaved "Own..." editor state; stays on this device, never synced. */
  const OWN_THEME_KEY = "own";

  /** Fired after local theme choices change (sync pushes them). */
  const THEME_LOCAL_CHANGE = "oneweek-theme-local-change";
  /** Fired after synced settings from another device were applied. */
  const THEME_REMOTE_CHANGE = "oneweek-theme-remote-change";

  /** Curated Google Fonts with Cyrillic (loaded on demand). id "" = built-in Proto Grotesk. */
  const GOOGLE_FONTS = [
    { id: "", label: "Proto Grotesk (default)", family: null },
    { id: "inter", label: "Inter", family: "Inter" },
    { id: "manrope", label: "Manrope", family: "Manrope" },
    { id: "ibm-plex-sans", label: "IBM Plex Sans", family: "IBM Plex Sans" },
    { id: "source-sans-3", label: "Source Sans 3", family: "Source Sans 3" },
    { id: "nunito", label: "Nunito", family: "Nunito" },
    { id: "rubik", label: "Rubik", family: "Rubik" },
    { id: "literata", label: "Literata", family: "Literata" },
    { id: "cormorant", label: "Cormorant", family: "Cormorant" },
    { id: "jost", label: "Jost", family: "Jost" },
  ];

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

  function getGoogleFontEntry(fontId) {
    const id = String(fontId ?? "");
    return GOOGLE_FONTS.find((f) => f.id === id) || GOOGLE_FONTS[0];
  }

  function googleFontsStylesheetUrl(family) {
    const param = encodeURIComponent(family).replace(/%20/g, "+");
    return `https://fonts.googleapis.com/css2?family=${param}:wght@400;600&display=swap`;
  }

  function ensureGoogleFontLoaded(family) {
    if (!family) return;
    const linkId = `google-font-${family.replace(/\s+/g, "-").toLowerCase()}`;
    if (document.getElementById(linkId)) return;
    const link = document.createElement("link");
    link.id = linkId;
    link.rel = "stylesheet";
    link.href = googleFontsStylesheetUrl(family);
    document.head.appendChild(link);
  }

  function applyFontById(fontId) {
    const root = document.documentElement;
    const entry = getGoogleFontEntry(fontId);
    if (!entry.family) {
      root.style.setProperty("--font-family", DEFAULT_FONT_STACK);
      return;
    }
    ensureGoogleFontLoaded(entry.family);
    root.style.setProperty(
      "--font-family",
      `"${entry.family}", system-ui, sans-serif`
    );
  }

  function hexToRgb(hex) {
    const n = normalizeHexColor(hex);
    if (!n) return null;
    return {
      r: parseInt(n.slice(1, 3), 16),
      g: parseInt(n.slice(3, 5), 16),
      b: parseInt(n.slice(5, 7), 16),
    };
  }

  function relativeLuminance(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return 1;
    const lin = (channel) => {
      const s = channel / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
  }

  function resolveBackgroundHex(bgHex) {
    const fromArg = normalizeHexColor(bgHex);
    if (fromArg) return fromArg;
    const inline = rootBackgroundFromDocument();
    if (inline) return inline;
    return DEFAULT_BG;
  }

  function rootBackgroundFromDocument() {
    const inline = document.documentElement.style
      .getPropertyValue("--color-background")
      .trim();
    const n0 = normalizeHexColor(inline);
    if (n0) return n0;
    if (typeof getComputedStyle !== "function") return "";
    const computed = getComputedStyle(document.documentElement)
      .getPropertyValue("--color-background")
      .trim();
    return normalizeHexColor(computed);
  }

  function syncTaskHighlightScheme(bgHex) {
    const scheme = relativeLuminance(resolveBackgroundHex(bgHex)) < 0.45
      ? "dark"
      : "light";
    document.documentElement.dataset.taskHighlights = scheme;
  }

  function applyThemeToDocument(textHex, bgHex, fontId) {
    const root = document.documentElement;
    if (textHex) root.style.setProperty("--color-text", textHex);
    else root.style.removeProperty("--color-text");
    if (bgHex) root.style.setProperty("--color-background", bgHex);
    else root.style.removeProperty("--color-background");
    if (fontId !== undefined) applyFontById(fontId);
    syncTaskHighlightScheme(bgHex);
    const themeColor = normalizeHexColor(bgHex) || resolveBackgroundHex(bgHex);
    if (themeColor) {
      document.querySelectorAll('meta[name="theme-color"]').forEach((el) => {
        el.setAttribute("content", themeColor);
      });
    }
  }

  const PRESETS = {
    white: {
      text: "#000000",
      bg: "#ffffff",
      label: "White",
    },
    black: {
      text: "#ffffff",
      bg: "#000000",
      label: "Black",
    },
    "native-light": {
      text: "#3a3f48",
      bg: "#eceef2",
      label: "Native light",
    },
    "native-dark": {
      text: "#e2e5ea",
      bg: "#2b3038",
      label: "Native dark",
    },
    pickmi: {
      text: "#6b2438",
      bg: "#f9e6ef",
      label: "Pickmi",
    },
  };

  function normalizeThemeEntry(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id = String(raw.id ?? "").trim();
    const text = normalizeHexColor(raw.text);
    const bg = normalizeHexColor(raw.bg);
    if (!id || !text || !bg) return null;
    return {
      id,
      name: String(raw.name ?? "").trim(),
      text,
      bg,
      fontId: getGoogleFontEntry(raw.fontId).id,
    };
  }

  function normalizeThemeList(themes) {
    return Array.isArray(themes) ? themes.map(normalizeThemeEntry).filter(Boolean) : [];
  }

  function getCustomThemes() {
    try {
      const raw = localStorage.getItem(THEME_CUSTOM_THEMES_KEY);
      return raw ? normalizeThemeList(JSON.parse(raw)) : [];
    } catch (_) {
      return [];
    }
  }

  function writeCustomThemes(themes) {
    const clean = normalizeThemeList(themes);
    try {
      localStorage.setItem(THEME_CUSTOM_THEMES_KEY, JSON.stringify(clean));
    } catch (_) {
      /* ignore */
    }
    return clean;
  }

  function saveCustomThemes(themes) {
    const clean = writeCustomThemes(themes);
    markThemeChanged();
    return clean;
  }

  function findCustomTheme(id) {
    return getCustomThemes().find((t) => t.id === id) || null;
  }

  function isCustomThemeKey(key) {
    return typeof key === "string" && key.startsWith("custom:");
  }

  function customThemeIdFromKey(key) {
    return isCustomThemeKey(key) ? key.slice(7) : "";
  }

  function customThemeSelectKey(id) {
    return `custom:${id}`;
  }

  function generateThemeId() {
    return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
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

  function getThemeUpdatedAt() {
    try {
      return localStorage.getItem(THEME_UPDATED_AT_KEY) || null;
    } catch (_) {
      return null;
    }
  }

  function setThemeUpdatedAt(iso) {
    try {
      if (iso) localStorage.setItem(THEME_UPDATED_AT_KEY, iso);
    } catch (_) {
      /* ignore */
    }
  }

  function markThemeChanged() {
    setThemeUpdatedAt(new Date().toISOString());
    window.dispatchEvent(new CustomEvent(THEME_LOCAL_CHANGE));
  }

  function getSelectedThemeKey() {
    try {
      return localStorage.getItem(THEME_SELECTED_KEY) || DEFAULT_THEME_KEY;
    } catch (_) {
      return DEFAULT_THEME_KEY;
    }
  }

  function writeSelectedThemeKey(key) {
    try {
      localStorage.setItem(THEME_SELECTED_KEY, key);
    } catch (_) {
      /* ignore */
    }
  }

  function setSelectedThemeKey(key) {
    writeSelectedThemeKey(key);
    if (key !== OWN_THEME_KEY) markThemeChanged();
  }

  const darkSchemeQuery =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)")
      : null;

  /** Preset key a selection resolves to right now (`auto` follows the OS). */
  function effectiveThemeKey(key) {
    if (key !== AUTO_THEME_KEY) return key;
    return darkSchemeQuery?.matches ? AUTO_DARK_PRESET : AUTO_LIGHT_PRESET;
  }

  /** Apply a preset, `auto`, or `custom:<id>`. Returns false if unknown. */
  function applyThemeKey(key) {
    const resolved = effectiveThemeKey(key);
    if (isCustomThemeKey(resolved)) {
      const theme = findCustomTheme(customThemeIdFromKey(resolved));
      if (!theme) return false;
      persistTheme(theme.text, theme.bg);
      applyThemeToDocument(theme.text, theme.bg, theme.fontId || "");
      return true;
    }
    const preset = PRESETS[resolved];
    if (!preset) return false;
    persistTheme(preset.text, preset.bg);
    applyThemeToDocument(preset.text, preset.bg, "");
    return true;
  }

  /** Is `key` something the theme select can show right now? */
  function isKnownThemeKey(key) {
    if (key === AUTO_THEME_KEY || key === OWN_THEME_KEY) return true;
    if (PRESETS[key]) return true;
    return isCustomThemeKey(key) && !!findCustomTheme(customThemeIdFromKey(key));
  }

  function applyOwnDraftFromStorage() {
    try {
      const nt = normalizeHexColor(localStorage.getItem(THEME_STORAGE_TEXT));
      const nb = normalizeHexColor(localStorage.getItem(THEME_STORAGE_BG));
      applyThemeToDocument(nt, nb, "");
    } catch (_) {
      /* ignore */
    }
  }

  function initThemeFromStorage() {
    const selected = getSelectedThemeKey();
    if (selected === OWN_THEME_KEY) {
      applyOwnDraftFromStorage();
      return;
    }
    if (applyThemeKey(selected)) return;
    writeSelectedThemeKey(DEFAULT_THEME_KEY);
    applyThemeKey(DEFAULT_THEME_KEY);
  }

  /**
   * Adopt settings synced from another device. `selected` may be null when
   * that device was mid-edit in "Own..." — then only the theme list changes.
   */
  function applyRemoteThemeSettings({ selected, customThemes, updatedAt }) {
    writeCustomThemes(customThemes);
    if (selected && getSelectedThemeKey() !== OWN_THEME_KEY) {
      writeSelectedThemeKey(isKnownThemeKey(selected) ? selected : DEFAULT_THEME_KEY);
      applyThemeKey(getSelectedThemeKey());
    }
    setThemeUpdatedAt(updatedAt);
    window.dispatchEvent(new CustomEvent(THEME_REMOTE_CHANGE));
  }

  function onColorSchemeChange() {
    if (getSelectedThemeKey() === AUTO_THEME_KEY) applyThemeKey(AUTO_THEME_KEY);
  }

  if (darkSchemeQuery) {
    if (typeof darkSchemeQuery.addEventListener === "function") {
      darkSchemeQuery.addEventListener("change", onColorSchemeChange);
    } else if (typeof darkSchemeQuery.addListener === "function") {
      darkSchemeQuery.addListener(onColorSchemeChange);
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

  function getStoredCustomFontId() {
    try {
      const raw = localStorage.getItem(THEME_CUSTOM_FONT_KEY) || "";
      return getGoogleFontEntry(raw).id;
    } catch (_) {
      return "";
    }
  }

  initThemeFromStorage();

  window.oneweekTheme = {
    THEME_STORAGE_TEXT,
    THEME_STORAGE_BG,
    THEME_CUSTOM_FONT_KEY,
    DEFAULT_TEXT,
    DEFAULT_BG,
    DEFAULT_THEME_KEY,
    AUTO_THEME_KEY,
    OWN_THEME_KEY,
    THEME_LOCAL_CHANGE,
    THEME_REMOTE_CHANGE,
    GOOGLE_FONTS,
    PRESETS,
    normalizeHexColor,
    applyThemeToDocument,
    applyThemeKey,
    isKnownThemeKey,
    getSelectedThemeKey,
    setSelectedThemeKey,
    getThemeUpdatedAt,
    setThemeUpdatedAt,
    applyRemoteThemeSettings,
    getStoredCustomFontId,
    getCustomThemes,
    saveCustomThemes,
    findCustomTheme,
    isCustomThemeKey,
    customThemeIdFromKey,
    customThemeSelectKey,
    generateThemeId,
    getCurrentHexForInput,
  };
})();
