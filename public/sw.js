// Minimal service worker so the site can be installed as an app.
// Pages always come from the network so cars and bookings stay current.
const CACHE = 'renthub-v2';
const ASSETS = ['/css/style.css', '/js/booking.js', '/icon.svg'];

self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS))));
self.addEventListener('activate', (e) =>
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || !ASSETS.includes(url.pathname)) return;
  e.respondWith(fetch(e.request).then((res) => {
    caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
    return res;
  }).catch(() => caches.match(e.request)));
});
