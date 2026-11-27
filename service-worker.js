const V = 'cosechadores-v1';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'db.js', 'sync.js', 'config.js', 'manifest.json', 'assets/LOGO_HUARMEY.png', 'assets/icon-192.png', 'assets/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== V).map(x => caches.delete(x)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return; // la API de Apps Script nunca se cachea aquí
  e.respondWith(caches.match(e.request).then(hit => {
    const net = fetch(e.request).then(r => { if (r.ok) caches.open(V).then(c => c.put(e.request, r.clone())); return r; });
    return hit || net.catch(() => caches.match('index.html'));
  }));
});
