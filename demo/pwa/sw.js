/* رِواء service worker — scope /demo/pwa/. Caches the app shell for offline use.
   Never touches /api/ (the coach always needs the network). */
const CACHE = 'riwaa-shell-v1';
const SHELL = [
  '/demo/pwa/',
  '/demo/pwa/manifest.webmanifest',
  '/demo/pwa/icons/icon.svg',
  '/demo/pwa/icons/icon-192.png',
  '/demo/pwa/icons/icon-512.png',
  '/demo/pwa/icons/icon-maskable-512.png',
  '/demo/pwa/icons/apple-touch-icon.png',
  '/assets/yh-mark-on-light.svg'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('riwaa-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // fonts etc. go straight to the network
  if (url.pathname.startsWith('/api/')) return;             // never cache the API

  if (req.mode === 'navigate') {
    // Network first so updates arrive; fall back to the cached shell offline.
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && url.pathname.startsWith('/demo/pwa/')) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('/demo/pwa/', copy));
          }
          return res;
        })
        .catch(() => caches.match('/demo/pwa/'))
    );
    return;
  }

  if (!SHELL.includes(url.pathname)) return;
  // Static shell files: cache first, refresh in the background.
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
