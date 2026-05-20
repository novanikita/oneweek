(function () {
  const STORAGE_KEY = "oneweek-about-lang";

  const STRINGS = {
    en: {
      "meta.title": "About oneweek",
      "nav.try": "Try now",
      "hero.title": "Oneweek a planner<br> for a world in flux",
      "what.heading": "What it is",
      "what.body":
        "One week on a screen — everything important in view. Plan for the week you're living in now, without noise from far-off deadlines and endless lists.",
      "features.heading": "Features",
      "features.1":
        "<strong>Custom themes</strong> — your own text color, background, and font for the mood or task at hand.",
      "features.2":
        "<strong>Time-anchored tasks</strong> — pin something to a moment during the week so it doesn't get lost in the flow.",
      "features.3":
        "<strong>Shared task inbox</strong> — tasks without a specific day that you can drag into any date when the time comes.",
      "features.4":
        "<strong>Color coding</strong> — highlight what matters most so it stands out at a glance.",
      "free.heading": "Free, period",
      "free.1": "No ads — ever.",
      "free.2":
        "Every feature that exists today and everything we add later stays free for everyone.",
      "free.3": "No spam or newsletters — your email is only for signing in and saving your tasks.",
      "cta.try": "Try now",
      "reviews.heading": "User feedback board",
      "reviews.body":
        "Reviews here aren't moderated: I don't delete negative ones or make up positive ones. Anyone who used oneweek for more than a week can leave a review.",
    },
    ru: {
      "meta.title": "О oneweek",
      "nav.try": "Попробовать",
      "hero.title": "Oneweek\u00A0— планер<br> для\u00A0мира, который не\u00A0стоит на\u00A0месте",
      "what.heading": "Что это такое",
      "what.body":
        "Всего одна неделя\u00A0— и\u00A0всё важное перед глазами. Планируйте ровно на\u00A0ту неделю, в\u00A0которой живёте сейчас, без\u00A0шума дальних сроков и\u00A0бесконечных списков.",
      "features.heading": "Функционал",
      "features.1":
        "<strong>Кастомные темы</strong>\u00A0— свой цвет текста, фона и\u00A0шрифт под\u00A0настроение или задачу.",
      "features.2":
        "<strong>Задачи по\u00A0времени</strong>\u00A0— привяжите дело к\u00A0моменту в\u00A0течение недели, чтобы оно не\u00A0потерялось в\u00A0общем потоке.",
      "features.3":
        "<strong>Общая корзина дел</strong>\u00A0— задачи без\u00A0конкретного дня, которые можно перетащить в\u00A0любой день, когда придёт время.",
      "features.4":
        "<strong>Цветовое кодирование</strong>\u00A0— выделите особенно важное, чтобы оно сразу бросалось в\u00A0глаза.",
      "free.heading": "Бесплатно, и\u00A0точка",
      "free.1": "Рекламы не\u00A0будет\u00A0— никогда.",
      "free.2":
        "Все функции, которые есть сейчас, и\u00A0все, что появятся позже, остаются бесплатными для\u00A0всех.",
      "free.3":
        "Никакого спама и\u00A0рассылок: ваша почта нужна только для\u00A0входа и\u00A0сохранения задач.",
      "cta.try": "Попробовать",
      "reviews.heading": "Доска отзывов",
      "reviews.body":
        "Отзывы здесь не\u00A0модерируются: я\u00A0не\u00A0удаляю плохие и\u00A0не\u00A0выдумываю хорошие. Оставить отзыв может каждый, кто пользовался oneweek больше одной недели.",
    },
  };

  function normalizeLang(lang) {
    return lang === "ru" ? "ru" : "en";
  }

  function getStoredLang() {
    try {
      return normalizeLang(localStorage.getItem(STORAGE_KEY) || "en");
    } catch {
      return "en";
    }
  }

  function setStoredLang(lang) {
    try {
      localStorage.setItem(STORAGE_KEY, normalizeLang(lang));
    } catch {
      /* ignore */
    }
  }

  function applyLang(lang) {
    const l = normalizeLang(lang);
    const dict = STRINGS[l];
    if (!dict) return;

    document.documentElement.lang = l;

    const titleEl = document.querySelector("title[data-i18n]");
    if (titleEl) titleEl.textContent = dict["meta.title"];

    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      if (!key || !(key in dict)) return;
      el.textContent = dict[key];
    });

    document.querySelectorAll("[data-i18n-html]").forEach((el) => {
      const key = el.getAttribute("data-i18n-html");
      if (!key || !(key in dict)) return;
      el.innerHTML = dict[key];
    });

    document.querySelectorAll(".about-lang-btn").forEach((btn) => {
      const active = btn.getAttribute("data-lang") === l;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function initLangSwitch() {
    const root = document.querySelector(".about-lang-switch");
    if (!root) return;

    root.addEventListener("click", (e) => {
      const btn = e.target.closest(".about-lang-btn");
      if (!btn) return;
      const lang = btn.getAttribute("data-lang");
      if (!lang) return;
      setStoredLang(lang);
      applyLang(lang);
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    initLangSwitch();
    applyLang(getStoredLang());
  });
})();
