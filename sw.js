/**
 * Service worker: keeps the briefing readable after the network goes.
 *
 * Two caches with different rules, because the two kinds of content fail
 * differently:
 *
 *   shell   the app itself. Served from cache so a cold start is instant, then
 *           refetched in the background so the copy on disk is never more than
 *           one launch behind a deploy. Plain cache-first would pin whatever
 *           version happened to install first until the cache name changed.
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

  event.respondWith(isData ? networkFirst(request) : staleWhileRevalidate(request, event));
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

/**
 * Hands back the cached copy at once and refreshes it in the background, so
 * the app starts instantly and still picks up a deploy on the next launch.
 *
 * The revalidation is deliberately not awaited when there is a hit -- waiting
 * on it would turn every load back into a network round trip and lose the
 * point. `waitUntil` keeps the worker alive until it finishes.
 */
async function staleWhileRevalidate(request, event) {
  const cached = await caches.match(request);

  const network = fetch(request)
    .then(async (response) => {
      if (response.ok) {
        const cache = await caches.open(SHELL);
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    event.waitUntil(network);
    return cached;
  }

  const response = await network;
  if (response) return response;

  // A navigation that misses everything still gets the shell, so the app
  // opens offline instead of showing the browser's error page.
  if (request.mode === 'navigate') {
    const shell = await caches.match('./index.html');
    if (shell) return shell;
  }
  return Response.error();
}
