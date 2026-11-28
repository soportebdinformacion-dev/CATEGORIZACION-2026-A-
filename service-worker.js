const CACHE = 'huarmey-categorizacion-v1';
const SHELL = ['./', './index.html', './manifest.json', './LOGO_HUARMEY.png', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  // Nunca interceptar Apps Script / otros orígenes: los datos van por IndexedDB
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  // Stale-while-revalidate para el app shell
  e.respondWith(caches.match(req, {ignoreSearch: true}).then(cached => {
    const net = fetch(req).then(res => {
      if (res.ok) caches.open(CACHE).then(c => c.put(req, res.clone()));
      return res;
    }).catch(() => cached || caches.match('./index.html'));
    return cached || net;
  }));
});
