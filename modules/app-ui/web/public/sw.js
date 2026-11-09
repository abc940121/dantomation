// Minimal service worker (our own, MIT). It exists so browsers treat the app as installable.
// It caches nothing: every request goes to the network, API calls included.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api') || /^\/m\/[^/]+\/api(\/|$)/.test(url.pathname)) return; // never touched
  event.respondWith(fetch(req)); // network-first passthrough
});
