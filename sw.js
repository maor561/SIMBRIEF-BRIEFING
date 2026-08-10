/**
 * Service worker: keeps the briefing readable after the network goes.
 *
 * Two caches with different rules, because the two kinds of content fail
 * differently:
 *
 *   shell   the app itself. Cache-first -- it only changes when deployed, and
 *           serving it from disk is also what makes a cold start instant.
 *   data    OFP, weather, VATSIM, SimBrief images. Network-first, falling back
 *           to the last copy. Fresh when there is a connection, and the last
 *           known state rather than an error page when there is not.
 *
 * Never cached: nothing. An API error response is passed through rather than
 * stored, so a failed fetch cannot poison the fallback with an error body.
 */

const VERSION = 'v1';
const SHELL = `sbb-shell-${VERSION}`;
const DATA = `sbb-data-${VERSION}`;

const SHELL_FILES = [
  './',
  './index.html',
  './css/brief.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/i18n.js',
  './js/normalize.js',
  './js/analyze.js',
  './js/decode.js',
  './js/ui.js',
  './js/charts.js',
  './js/masonry.js',
  './js/vatsim.js',
  './js/fuellog.js',
  './js/views/overview.js',
  './js/views/weather.js',
  './js/views/notams.js',
  './js/views/fuel.js',
  './js/views/performance.js',
  './js/views/atc.js',
  './js/views/navlog.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      // One miss must not fail the whole install, so each file is added on
      // its own and a failure is tolerated.
      .then((cache) => Promise.all(SHELL_FILES.map((file) => cache.add(file).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((n) => n !== SHELL && n !== DATA).map((n) => caches.delete(n)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isData =
    url.pathname.includes('/api/') ||
    url.pathname.endsWith('fixture.json') ||
    url.hostname.endsWith('simbrief.com');

  event.respondWith(isData ? networkFirst(request) : cacheFirst(request));
});

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    // Only a good response is worth keeping; caching an error would hand it
    // back as the "last known state" forever.
    if (response.ok) {
      const cache = await caches.open(DATA);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    // A navigation that misses everything still gets the shell, so the app
    // opens offline instead of showing the browser's error page.
    if (request.mode === 'navigate') {
      const shell = await caches.match('./index.html');
      if (shell) return shell;
    }
    throw err;
  }
}
