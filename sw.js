/* KockBot service worker
 * - Appens egna filer visas direkt från enhetens cache och uppdateras i bakgrunden.
 * - Bibliotek och typsnitt från CDN sparas också, så att appen startar utan täckning.
 * - Databas, inloggning, AI och bilduppladdning går alltid direkt mot nätet (Firebase sköter själv sin offline-cache).
 * Versionen byts automatiskt av byggskriptet; när den ändras installeras den nya versionen och appen visar "Ny version finns".
 */
const VERSION = 'a88f715736';
const APP_CACHE = `kockbot-app-${VERSION}`;
const CDN_CACHE = 'kockbot-cdn-v1';
const PRECACHE = ['./KockBot.html', './kockbot-app.js?v=a88f715736', './kockbot.css?v=a88f715736', './logo.png'];
const CDN_HOSTS = ['www.gstatic.com', 'esm.sh', 'unpkg.com', 'cdn.tailwindcss.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    // Filer som saknas (t.ex. om sidan heter index.html) hoppas över i stället för att stoppa installationen
    await Promise.allSettled(PRECACHE.map((url) => cache.add(new Request(url, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('kockbot-app-') && k !== APP_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

const staleWhileRevalidate = async (event, cacheName) => {
  const request = event.request;
  const cache = await caches.open(cacheName);
  const isNavigation = request.mode === 'navigate';
  const cached = await cache.match(request, { ignoreSearch: isNavigation, ignoreVary: true });
  const network = fetch(request)
    .then((response) => {
      if (response && (response.ok || response.type === 'opaque')) cache.put(request, response.clone()).catch(() => {});
      return response;
    })
    .catch(() => null);
  if (cached) {
    event.waitUntil(network);
    return cached;
  }
  const response = await network;
  if (response) return response;
  if (isNavigation) {
    const fallback = await cache.match('./KockBot.html');
    if (fallback) return fallback;
  }
  return Response.error();
};

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.endsWith('/sw.js')) return;
    event.respondWith(staleWhileRevalidate(event, APP_CACHE));
    return;
  }
  if (CDN_HOSTS.includes(url.hostname) && !url.pathname.startsWith('/identitytoolkit')) {
    event.respondWith(staleWhileRevalidate(event, CDN_CACHE));
  }
  // Allt annat (Firestore, inloggning, Gemini, Storage, AI-bilder) går direkt till nätet.
});
