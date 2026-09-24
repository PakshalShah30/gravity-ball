/**
 * sw.js — offline support. The whole game is ~30 static files, so they are
 * precached on install and served cache-first; a new VERSION swaps the cache.
 *
 * tools/pwa-check.mjs fails the test suite if a file under src/ is missing
 * from ASSETS, so the list cannot silently drift out of date.
 */
const VERSION = 'gb-v2';
const ASSETS = [
  './',
  'index.html',
  'editor.html',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-maskable.svg',
  'src/styles.css',
  'src/config.js',
  'src/main.js',
  'src/core/audio.js',
  'src/core/fx.js',
  'src/core/input.js',
  'src/core/math.js',
  'src/core/particles.js',
  'src/editor/editor.css',
  'src/editor/editor.js',
  'src/game/level.js',
  'src/game/levelcode.js',
  'src/game/paddle.js',
  'src/game/world.js',
  'src/meta/panels.js',
  'src/meta/progress.js',
  'src/render/bg.js',
  'src/render/hud.js',
  'src/render/renderer.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match('index.html'))),
  );
});
