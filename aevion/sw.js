/* ============================================================
 * Aevion Service Worker — offline-first cache
 * Strategy: network-first (updates land immediately), cache fallback
 * when offline, plus a pre-warmed cache per CACHE_VERSION.
 * ============================================================ */
const CACHE_VERSION = 'aevion-v0.6.6';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './assets/icon.svg',
  './css/themes.css',
  './css/style.css',
  './js/core.js',
  './js/theme.js',
  './js/nlu.js',
  './js/brain.js',
  './js/skills.js',
  './js/memory.js',
  './js/tools.js',
  './js/attach.js',
  './js/evolve.js',
  './js/plugins.js',
  './js/voices.js',
  './js/voice.js',
  './js/wake.js',
  './js/providers.js',
  './js/online.js',
  './js/webllm.js',
  './js/setup.js',
  './js/apps.js',
  './js/update.js',
  './js/markdown.js',
  './js/app.js',
  './js/plugins/hello-world.js'
];

/* Fetched only when a model is actually used, never at install time:
   the engine is ~6.6 MB and would otherwise be downloaded by every
   visitor (and re-downloaded after each cache version bump). */
const LAZY_ASSETS = [
  './vendor/webllm.esm.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_VERSION).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

const LAZY = new Set(LAZY_ASSETS);

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // never intercept cross-origin calls (AI endpoints, translation, weather)
  if (url.origin !== location.origin) return;

  const path = './' + url.pathname.replace(/^\/+/, '').replace(/^aevion\//, '');

  // Vendor bundles are immutable: serve from cache immediately, and only
  // fetch once. This is what keeps the 6.6 MB engine off the startup path.
  if (LAZY.has(path)) {
    e.respondWith(
      caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).then(r => {
        if (r.ok) { const copy = r.clone(); caches.open(CACHE_VERSION).then(c => c.put(e.request, copy)); }
        return r;
      }))
    );
    return;
  }

  // App code: network-first, so an update lands on the next load, with the
  // cache as the offline fallback. (Bump CACHE_VERSION to re-warm.)
  e.respondWith(
    fetch(e.request)
      .then(r => {
        if (r.ok) {
          const copy = r.clone();
          caches.open(CACHE_VERSION).then(c => c.put(e.request, copy));
        }
        return r;
      })
      .catch(() =>
        caches.match(e.request, { ignoreSearch: true })
          .then(hit => hit || caches.match('./index.html'))
      )
  );
});
