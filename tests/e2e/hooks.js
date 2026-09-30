// Headless + virtual time only fires the first rAF; drive frames by timers.
window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
window.cancelAnimationFrame = (id) => clearTimeout(id);
window.__errs = [];
window.__toasts = [];
window.addEventListener("error", (e) => window.__errs.push(`ERR ${e.message} @${(e.filename || "").split("/").pop()}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => window.__errs.push(`REJ ${e.reason && (e.reason.message || e.reason)}`));
const __ce = console.error.bind(console);
console.error = (...a) => { window.__errs.push("CE " + a.map((x) => (x && x.message) || String(x)).join(" ")); __ce(...a); };
document.addEventListener("DOMContentLoaded", () => {
  const t = document.getElementById("app-toast");
  if (t) new MutationObserver(() => { if (!t.hidden && t.textContent) window.__toasts.push(t.textContent); }).observe(t, { attributes: true, childList: true });
});
