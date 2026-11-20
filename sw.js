// One service worker for all three tools: makes the app installable and lets the screens open offline.
// Bump CACHE when you release, so phones drop old copies.
const CACHE = 'petfriend-v28';
const SHELL = [
  './', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './config.js', './i18n.js', './settings.js', './labels.js',
  './pos/index.html', './orders/index.html', './picklist/index.html', './shipments/index.html', './today/index.html',
  'https://cdnjs.cloudflare.com/ajax/libs/html5-qrcode/2.3.8/html5-qrcode.min.js'
];

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the browser's HTTP cache, so a new version never stores old copies
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // API calls (POST to Apps Script) always go to the network
  const url = new URL(req.url);
  if (url.origin !== location.origin && url.hostname !== 'cdnjs.cloudflare.com') return;
  // Network first so updates show up straight away; fall back to the cache when offline.
  // Our own files are re-checked with the server every time (GitHub Pages otherwise lets the
  // browser reuse a copy for 10 minutes, which made new versions show up late).
  const fresh = url.origin === location.origin ? fetch(req, { cache: 'no-cache' }) : fetch(req);
  e.respondWith(
    fresh.then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req))
  );
});
