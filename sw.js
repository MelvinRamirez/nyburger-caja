// Service worker for the foodc-caja app shell (`caja-pwa-shell`).
//
// Precaches exclusively the versioned app shell (HTML, CSS, JS, manifest,
// icons). Never caches or intercepts backend API responses
// (script.google.com / script.googleusercontent.com): those requests always
// go straight to the network, with no cache read or write, even while
// offline (`caja-pwa-shell`, "API Requests Are Always Network-Only" —
// including the close request's long server time, since this check is on
// method/origin, never on request duration).

const CACHE_PREFIX = 'foodc-caja-shell-';
const CACHE_VERSION = 'foodc-caja-shell-v4'; // bump in the same commit as any shell file change

const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/config.js',
  './js/messages.js',
  './js/store.js',
  './js/api.js',
  './js/pin.js',
  './js/time.js',
  './js/queue.js',
  './js/payment.js',
  './js/close.js',
  './js/actions.js',
  './js/persistence.js',
  './js/effects.js',
  './js/main.js',
  './js/views/dom.js',
  './js/views/pin-view.js',
  './js/views/queue-view.js',
  './js/views/order-card-view.js',
  './js/views/status-bar-view.js',
  './js/views/close-view.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_VERSION)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Any non-GET request, or any request to an origin other than our own
  // (the backend API), is left alone: without calling `respondWith` the
  // browser handles it as usual, guaranteeing the API is always
  // "network-only" and never served from the shell cache. This holds
  // regardless of how long the server takes to respond (e.g. the close
  // request), since the check is on method/origin, not on timing.
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(caches.match('./index.html').then((cached) => cached || fetch(request)));
    return;
  }

  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
});
