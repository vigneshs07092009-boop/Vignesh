/* ============================================================
 * Aevion Service Worker — offline-first cache
 * Strategy: network-first (updates land immediately), cache fallback
 * when offline, plus a pre-warmed cache per CACHE_VERSION.
 * ============================================================ */
const CACHE_VERSION = 'aevion-v0.5.0';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './assets/icon.svg',
  './css/themes.css',
  './css/style.css',
  './js/core.js',
  './js/brain.js',
  './js/skills.js',
  './js/voice.js',
  './js/online.js',
  './js/webllm.js',
  './js/markdown.js',
  './vendor/webllm.esm.js',
  './js/app.js',
  './js/plugins/hello-world.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_VERSION).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

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
  // Network-first: get updates immediately, fall back to cache when offline.
  // (Bump CACHE_VERSION to pre-warm a new version.)
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
