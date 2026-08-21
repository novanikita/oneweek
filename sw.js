/* oneweek app-shell service worker — caches UI assets; never caches API. */
const CACHE = "oneweek-shell-v13";

const REQUIRED_PRECACHE = [
  "./",
  "./index.html",
  "./site.webmanifest",
  "./css/colors.css?v=20260812-1",
  "./css/styles.css?v=20260821-2",
  "./js/theme-init.js?v=20260813-1",
  "./js/vendor/supabase.js?v=2.49.8",
  "./js/workspaces.js?v=20260813-17",
  "./js/script.js?v=20260819-3",
  "./js/workspace-tabs.js?v=20260813-12",
  "./icons/favicon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-192-maskable.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon.png",
];

const OPTIONAL_PRECACHE = [
  "./about.html",
  "./css/about.css?v=20260813-1",
  "./js/about-i18n.js?v=20260813-1",
];

async function precacheRequired(cache) {
  await Promise.all(
    REQUIRED_PRECACHE.map(async (url) => {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Required precache failed (${res.status}): ${url}`);
      }
      await cache.put(url, res);
    })
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await precacheRequired(cache);
      await Promise.all(
        OPTIONAL_PRECACHE.map((url) => cache.add(url).catch(() => undefined))
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

function isSupabaseRequest(url) {
  return url.hostname.endsWith("supabase.co");
}

function isAboutNavigation(url) {
  const path = url.pathname;
  return (
    path.endsWith("/about.html") ||
    path.endsWith("/about") ||
    path.includes("/about.html")
  );
}

/** Email confirm / OAuth callbacks — let the browser follow redirects natively. */
function isAuthCallbackNavigation(url) {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path === "/auth/confirm" || path.startsWith("/auth/")) return true;
  if (url.searchParams.has("token_hash")) return true;
  if (url.searchParams.has("code")) return true;
  return false;
}

async function navigationFallback(request) {
  const url = new URL(request.url);

  if (isAboutNavigation(url)) {
    const about =
      (await caches.match("./about.html")) ||
      (await caches.match(new URL("./about.html", url.origin).href));
    if (about) return about;
  }

  const exact = await caches.match(request);
  if (exact) return exact;

  const index =
    (await caches.match("./index.html")) ||
    (await caches.match(new URL("./index.html", url.origin).href));
  if (index) return index;

  return Response.error();
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }

  // Never intercept Supabase / third-party API traffic.
  if (url.origin !== self.location.origin) {
    if (isSupabaseRequest(url)) return;
    return;
  }

  // Navigations: network first, route-aware offline fallback.
  if (req.mode === "navigate") {
    // Don't intercept auth callbacks — fetch() would follow a redirect to
    // index.html while leaving the document URL at /auth/confirm, which
    // breaks relative assets. Let the browser redirect to `/` natively.
    if (isAuthCallbackNavigation(url)) return;

    event.respondWith(
      fetch(req)
        .then((res) => {
          if (!res.ok) return navigationFallback(req);
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => navigationFallback(req))
    );
    return;
  }

  // Same-origin static assets: cache first, then network.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      });
    })
  );
});
