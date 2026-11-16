/* Beskapp service worker
   Gör appen installerbar och låter den starta utan internet.
   Sidan hämtas från nätet först, så att en ny version syns direkt.
   Utan nät används den senast sparade versionen. */

const CACHE = 'beskapp-v2';
const CORE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'icons/favicon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'lib/qrcode.js',
  'lib/jsQR.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.all(CORE.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Själva sidan: nätet först, sparad kopia om nätet saknas
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            event.waitUntil(caches.open(CACHE).then((c) => c.put('index.html', copy)));
          }
          return res;
        })
        .catch(() => caches.match('index.html').then((hit) => hit || caches.match('./')))
    );
    return;
  }

  // Ikoner, manifest och typsnitt: sparad kopia direkt, uppdateras i bakgrunden
  const sameOrigin = url.origin === self.location.origin;
  const fonts = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (!sameOrigin && !fonts) return;

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req);
      const fresh = fetch(req)
        .then((res) => {
          if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
          return res;
        })
        .catch(() => hit || Response.error());
      if (hit) {
        event.waitUntil(fresh);
        return hit;
      }
      return fresh;
    })
  );
});
