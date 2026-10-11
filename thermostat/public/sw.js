// Keeps the app shell available offline. Always tries the network first so a
// new version shows up on the next open, falling back to the cached copy if
// the network is slow or down. Live data (/api) never goes through the cache.
const CACHE = 'home-climate-v7';
const SHELL = ['/', '/app.js', '/styles.css', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-180.png'];
const NETWORK_TIMEOUT_MS = 2500;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  const key = e.request.mode === 'navigate' ? '/' : e.request;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const network = fetch(e.request, { cache: 'no-cache' }).then((res) => {
        if (res.ok) cache.put(key, res.clone());
        return res;
      });
      const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS));
      const fast = await Promise.race([network.catch(() => null), timeout]);
      if (fast) return fast;
      return (await cache.match(key)) || network;
    }),
  );
});
