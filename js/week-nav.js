/**
 * Week navigation — arrows, "Now", day-of-month labels, and the sidebar list
 * of weeks. Dispatches WEEK_CHANGE_EVENT after flushing pending saves.
 */

(() => {
  const weekdayToIndex = {
    Monday: 0,
    Tuesday: 1,
    Wednesday: 2,
    Thursday: 3,
    Friday: 4,
    Saturday: 5,
    Sunday: 6,
  };

  function updateDayOfMonthLabels() {
    const weekStart = getVisibleWeekStartDate();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const onThisWeek = Number(window.__weekOffset || 0) === 0;

    const dayRects = document.querySelectorAll(".day-rect[data-day]");
    dayRects.forEach((rect) => {
      const dayName = rect.dataset.day;
      const dayIndex = weekdayToIndex[dayName];
      if (dayIndex == null) {
        rect.classList.remove("is-today");
        return; // skip "Next week"
      }

      const date = new Date(weekStart);
      date.setDate(weekStart.getDate() + dayIndex);
      date.setHours(0, 0, 0, 0);

      const label = rect.querySelector(".day-label");
      if (!label) return;
      label.textContent = `${dayName}, ${date.getDate()}`;
      rect.classList.toggle(
        "is-today",
        onThisWeek && date.getTime() === today.getTime()
      );
    });
  }

  function scheduleNextUpdate() {
    updateDayOfMonthLabels();

    const now = new Date();
    const next = new Date(now);
    next.setHours(24, 0, 0, 0); // local midnight
    const delayMs = next.getTime() - now.getTime();

    window.setTimeout(scheduleNextUpdate, delayMs + 50);
  }

  function syncWeekAwayClass() {
    document.body.classList.toggle(
      "week-offset-away",
      Number(window.__weekOffset || 0) !== 0
    );
  }

  /**
   * Re-trigger the CSS week-switch animation. We toggle a class via
   * `force reflow → add` so the animation restarts cleanly even when the
   * user mashes the week arrows.
   */
  function playWeekSwitchAnimation() {
    const layout = document.querySelector(".layout");
    if (!layout) return;
    layout.classList.remove("is-week-switching");
    void layout.offsetWidth;
    layout.classList.add("is-week-switching");
    window.clearTimeout(playWeekSwitchAnimation._timer);
    playWeekSwitchAnimation._timer = window.setTimeout(() => {
      layout.classList.remove("is-week-switching");
    }, 320);
  }

  function shiftWeek(delta) {
    void (async () => {
      await flushAllTaskSaves();
      window.__weekOffset = Number(window.__weekOffset || 0) + delta;
      syncWeekAwayClass();
      updateDayOfMonthLabels();
      updateWeekNavLabel();
      renderWeeksList();
      playWeekSwitchAnimation();
      window.dispatchEvent(new CustomEvent(WEEK_CHANGE_EVENT));
    })();
  }

  function setWeekOffset(offset) {
    void (async () => {
      await flushAllTaskSaves();
      const previous = Number(window.__weekOffset || 0);
      window.__weekOffset = offset;
      syncWeekAwayClass();
      updateDayOfMonthLabels();
      updateWeekNavLabel();
      renderWeeksList();
      if (previous !== offset) playWeekSwitchAnimation();
      window.dispatchEvent(new CustomEvent(WEEK_CHANGE_EVENT));
    })();
  }

  const MONTH_NAMES = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];

  function formatWeekLabel(mondayDate) {
    const mon = new Date(mondayDate);
    const sun = new Date(mon);
    sun.setDate(sun.getDate() + 6);
    const d1 = mon.getDate();
    const m1 = MONTH_NAMES[mon.getMonth()];
    const d2 = sun.getDate();
    const m2 = MONTH_NAMES[sun.getMonth()];
    return `${d1} ${m1} — ${d2} ${m2}`;
  }

  function getWeekNavLabel(offset) {
    if (offset === 0) return "this week";
    if (offset === 1) return "next week";
    if (offset === -1) return "last week";
    return formatWeekLabel(getWeekMondayStart(new Date(), offset));
  }

  const weekNavLabel = document.getElementById("week-nav-label");
  const weekGoThisWeekBtn = document.getElementById("week-go-this-week");

  function updateWeekNavLabel() {
    const offset = Number(window.__weekOffset || 0);
    if (weekNavLabel) weekNavLabel.textContent = getWeekNavLabel(offset);
    if (weekGoThisWeekBtn) weekGoThisWeekBtn.hidden = offset === 0;
  }

  const PAST_WEEKS_COUNT = 12;
  const weeksList = document.getElementById("weeks-list");

  function renderWeeksList() {
    if (!weeksList) return;
    const currentOffset = Number(window.__weekOffset || 0);
    weeksList.innerHTML = "";

    for (let offset = 1; offset >= -PAST_WEEKS_COUNT; offset--) {
      const monday = getWeekMondayStart(new Date(), offset);
      const dateLabel = formatWeekLabel(monday);
      const li = document.createElement("li");

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "weeks-list-btn";
      if (offset === currentOffset) {
        btn.classList.add("week-active");
        btn.setAttribute("aria-current", "true");
      }

      const dates = document.createElement("span");
      dates.className = "weeks-list-dates";
      dates.textContent = dateLabel;
      btn.appendChild(dates);

      let tagText = null;
      if (offset === 0) tagText = "now";
      else if (offset === 1) tagText = "next week";
      else if (offset === -1) tagText = "last week";

      if (tagText) {
        const tag = document.createElement("span");
        tag.className = "weeks-list-tag";
        tag.textContent = tagText;
        btn.appendChild(tag);
      }

      btn.addEventListener("click", () => setWeekOffset(offset));
      li.appendChild(btn);
      weeksList.appendChild(li);
    }
  }

  const prevBtn = document.getElementById("week-prev");
  const nextBtn = document.getElementById("week-next");
  if (prevBtn) prevBtn.addEventListener("click", () => shiftWeek(-1));
  if (nextBtn) nextBtn.addEventListener("click", () => shiftWeek(1));
  if (weekGoThisWeekBtn) {
    weekGoThisWeekBtn.addEventListener("click", () => setWeekOffset(0));
  }

  syncWeekAwayClass();
  updateWeekNavLabel();
  scheduleNextUpdate();
  renderWeeksList();
})();
