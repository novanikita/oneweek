(function () {
  const THEME_STORAGE_TEXT = "oneweek-theme-color-text";
  const THEME_STORAGE_BG = "oneweek-theme-color-background";
  const THEME_CUSTOM_FONT_KEY = "oneweek-custom-font";
  const THEME_CUSTOM_THEMES_KEY = "oneweek-custom-themes";
  const THEME_SELECTED_KEY = "oneweek-theme-selected";
  const LEGACY_CUSTOM_TEXT_KEY = "oneweek-custom-text";
  const LEGACY_CUSTOM_BG_KEY = "oneweek-custom-bg";
  const LEGACY_CUSTOM_NAME_KEY = "oneweek-custom-name";
  const DEFAULT_TEXT = "#000000";
  const DEFAULT_BG = "#ffffff";
  const DEFAULT_FONT_STACK = '"Proto Grotesk", system-ui, sans-serif';

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

  /** Old font ids (no Cyrillic) → current ids. */
  const LEGACY_FONT_IDS = {
    "dm-sans": "manrope",
    "work-sans": "rubik",
    "fraunces": "cormorant",
    "space-grotesk": "jost",
  };

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

  function resolveFontId(fontId) {
    const id = String(fontId ?? "");
    return LEGACY_FONT_IDS[id] || id;
  }

  function getGoogleFontEntry(fontId) {
    const id = resolveFontId(fontId);
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

  function applyThemeToDocument(textHex, bgHex, fontId) {
    const root = document.documentElement;
    if (textHex) root.style.setProperty("--color-text", textHex);
    else root.style.removeProperty("--color-text");
    if (bgHex) root.style.setProperty("--color-background", bgHex);
    else root.style.removeProperty("--color-background");
    if (fontId !== undefined) applyFontById(fontId);
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

  const LEGACY_THEME_KEYS = {
    light: "white",
    dark: "black",
    "true-pickmi": "pickmi",
  };

  function migrateThemeKey(key) {
    return LEGACY_THEME_KEYS[key] || key;
  }

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

  function parseCustomThemes() {
    try {
      const raw = localStorage.getItem(THEME_CUSTOM_THEMES_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.map(normalizeThemeEntry).filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  function saveCustomThemes(themes) {
    const clean = themes.map(normalizeThemeEntry).filter(Boolean);
    try {
      localStorage.setItem(THEME_CUSTOM_THEMES_KEY, JSON.stringify(clean));
    } catch (_) {
      /* ignore */
    }
    return clean;
  }

  function migrateLegacyCustomThemes() {
    let themes = parseCustomThemes();
    if (themes.length > 0) return themes;

    try {
      const t = localStorage.getItem(LEGACY_CUSTOM_TEXT_KEY);
      const b = localStorage.getItem(LEGACY_CUSTOM_BG_KEY);
      if (!t || !b) return [];

      const text = normalizeHexColor(t);
      const bg = normalizeHexColor(b);
      if (!text || !bg) return [];

      const id = "migrated";
      const name = String(localStorage.getItem(LEGACY_CUSTOM_NAME_KEY) || "Custom").trim();
      const fontId = getStoredCustomFontId();
      themes = [{ id, name, text, bg, fontId }];
      saveCustomThemes(themes);

      if (localStorage.getItem(THEME_SELECTED_KEY) === "custom") {
        localStorage.setItem(THEME_SELECTED_KEY, `custom:${id}`);
      }

      localStorage.removeItem(LEGACY_CUSTOM_TEXT_KEY);
      localStorage.removeItem(LEGACY_CUSTOM_BG_KEY);
      localStorage.removeItem(LEGACY_CUSTOM_NAME_KEY);
    } catch (_) {
      /* ignore */
    }

    return themes;
  }

  function getCustomThemes() {
    return migrateLegacyCustomThemes();
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

  function initThemeFromStorage() {
    try {
      migrateLegacyCustomThemes();
      let selected = migrateThemeKey(
        localStorage.getItem(THEME_SELECTED_KEY) || "white"
      );
      if (selected !== localStorage.getItem(THEME_SELECTED_KEY)) {
        localStorage.setItem(THEME_SELECTED_KEY, selected);
      }

      if (selected === "custom") {
        const ct = localStorage.getItem(LEGACY_CUSTOM_TEXT_KEY);
        const cb = localStorage.getItem(LEGACY_CUSTOM_BG_KEY);
        if (ct && cb) {
          applyThemeToDocument(
            normalizeHexColor(ct),
            normalizeHexColor(cb),
            getStoredCustomFontId()
          );
          return;
        }
        selected = "white";
      }

      if (isCustomThemeKey(selected)) {
        const theme = findCustomTheme(customThemeIdFromKey(selected));
        if (theme) {
          persistTheme(theme.text, theme.bg);
          applyThemeToDocument(theme.text, theme.bg, theme.fontId || "");
          return;
        }
        localStorage.setItem(THEME_SELECTED_KEY, "white");
        selected = "white";
      }

      if (PRESETS[selected]) {
        applyThemeToDocument(PRESETS[selected].text, PRESETS[selected].bg, "");
        return;
      }
      const t = localStorage.getItem(THEME_STORAGE_TEXT);
      const b = localStorage.getItem(THEME_STORAGE_BG);
      const nt = t ? normalizeHexColor(t) : "";
      const nb = b ? normalizeHexColor(b) : "";
      if (t && !nt) localStorage.removeItem(THEME_STORAGE_TEXT);
      if (b && !nb) localStorage.removeItem(THEME_STORAGE_BG);
      applyThemeToDocument(nt, nb, "");
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
    THEME_CUSTOM_THEMES_KEY,
    THEME_SELECTED_KEY,
    DEFAULT_TEXT,
    DEFAULT_BG,
    DEFAULT_FONT_STACK,
    GOOGLE_FONTS,
    PRESETS,
    migrateThemeKey,
    normalizeHexColor,
    applyThemeToDocument,
    applyFontById,
    getGoogleFontEntry,
    getStoredCustomFontId,
    getCustomThemes,
    saveCustomThemes,
    findCustomTheme,
    isCustomThemeKey,
    customThemeIdFromKey,
    customThemeSelectKey,
    generateThemeId,
    initThemeFromStorage,
    persistTheme,
    getCurrentHexForInput,
  };
})();
