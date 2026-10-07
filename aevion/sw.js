/* ============================================================
 * Aevion Service Worker — offline-first cache
 * Strategy: network-first (updates land immediately), cache fallback
 * when offline, plus a pre-warmed cache per CACHE_VERSION.
 * ============================================================ */
const CACHE_VERSION = 'aevion-v0.6.9';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './assets/icon.svg',
  './assets/icon-192.png',
  './assets/icon-512.png',
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

/* ---------------------------------------------------------------------------
 * The localhost twins: http://localhost:8787 and http://127.0.0.1:8787 are the
 * same server, but a browser treats every origin as its own little world —
 * separate localStorage, separate IndexedDB, separate service worker. Someone
 * who opens the app through one name and configures their brain, then comes
 * back through the other, finds an empty app: the "no brain" report is almost
 * never a lost brain, it is the same brain seen through the other door.
 *
 * So both names carry the same cache. On every activate (that is, after each
 * release, since CACHE_VERSION changes with it), whichever worker woke up
 * reads the twin's cache for every shared asset and copies any entry that is
 * missing here. A first visit through the other door then boots warm — assets,
 * logic and the pinned WebLLM engine — in one hop, instead of re-fetching
 * ~7 MB from the loopback server. The canonical door is 127.0.0.1 (the one
 * the installed app and the desktop launcher open).
 *
 * The two doors still do not share *storage*: localStorage and IndexedDB have
 * no cross-origin API, by design. The server is the one shared source of
 * truth, and serve.ps1 now opens only one canonical name for both doors.
 * ------------------------------------------------------------------------ */
const TWIN_ORIGINS = [
  'http://localhost:8787',
  'http://127.0.0.1:8787'
];

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const here = location.origin;
    const twins = TWIN_ORIGINS.filter(o => o !== here);

    for (const twin of twins) {
      try {
        const twinCache = await caches.open('aevion-twin:' + twin);
        const mine = await caches.open(CACHE_VERSION);
        const requests = await twinCache.keys();
        for (const req of requests) {
          const hit = await twinCache.match(req);
          if (!hit) continue;
          const url = new URL(req.url);
          const path = './' + url.pathname.replace(/^\/+/, '').replace(/^aevion\//, '');
          const already = await mine.match(req, { ignoreSearch: true });
          if (already) continue;                     // fresh enough: network-first anyway
          const stillGood = await fetch(req, { cache: 'no-cache' }).catch(() => null);
          const copy = (stillGood && stillGood.ok) ? stillGood : hit;
          await mine.put(req, copy);
        }
      } catch (_) { /* the twin may not exist yet; a cold cache is fine */ }
    }

    // remember what we synced so the next activate can tell fresh from stale
    const index = await caches.open(CACHE_VERSION);
    await index.put('./__twin-sync', new Response(JSON.stringify({ from: twins, at: Date.now() })));
  })());
});
