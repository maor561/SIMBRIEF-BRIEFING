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

// Bumped because v1 could have redirected responses stored in it (see
// cachePlain below) -- those must be evicted outright, not merged with.
const VERSION = 'v2';
const SHELL = `sbb-shell-${VERSION}`;
const DATA = `sbb-data-${VERSION}`;

const SHELL_FILES = [
  './',
  './index.html',
  './manual.html',
  './css/brief.css',
  './manifest.webmanifest',
  './icons/icon.svg',
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
  './js/views/navlog.js',
  './js/views/report.js',
  './js/timeline.js',
  './js/notamlog.js',
  './js/wind.js',
  './js/glossary.js'
];

/**
 * Stores a response with its redirect history stripped out.
 *
 * Vercel 308s a handful of paths to their canonical form (a bare directory to
 * its index, a doubled slash, ...). `fetch` follows that transparently and
 * hands back a `Response` flagged `redirected: true` -- fine to read once, but
 * Chrome refuses to let a *cached copy* of that response satisfy a later
 * `fetch` event, and fails the whole request instead: "a redirected response
 * was used for a request whose redirect mode is not follow." `cache.add()`
 * stores exactly that flagged response with no way to intervene, which is
 * what put every shell file behind a redirect out of reach the moment the
 * service worker tried to serve it from cache.
 *
 * Rebuilding a plain `Response` from the body before storing removes the
 * flag, so what comes back out of the cache later is never a redirect
 * replay -- just the bytes, which is all a cached copy ever needed to be.
 */
async function cachePlain(cache, request, response) {
  const body = await response.blob();
  const plain = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
  await cache.put(request, plain);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      // One miss must not fail the whole install, so each file is fetched and
      // stored on its own and a failure is tolerated.
      .then((cache) =>
        Promise.all(
          SHELL_FILES.map((file) =>
            fetch(file, { redirect: 'follow' })
              .then((response) => (response.ok ? cachePlain(cache, file, response) : null))
              .catch(() => {})
          )
        )
      )
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
      cachePlain(cache, request, response.clone());
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
        await cachePlain(cache, request, response.clone());
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
