/**
 * Service Worker - Categorización de Cosechadores 2026+
 * Estrategia:
 * - Recursos estáticos (App Shell): Cache-First con actualización en segundo plano.
 * - Llamadas a Google Apps Script: Network-Only (manejadas por IndexedDB y sync.js).
 */

const CACHE_NAME = 'huarmey-cosechadores-v1.0.0';

const APP_SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './db.js',
  './sync.js',
  './manifest.json',
  './LOGO HUARMEY.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);

  // No interceptar peticiones a Google Apps Script (las gestiona sync.js + IndexedDB)
  if (
    requestUrl.hostname.includes('script.google.com') ||
    requestUrl.hostname.includes('script.googleusercontent.com') ||
    event.request.method !== 'GET'
  ) {
    return;
  }

  // Estrategia Cache-First para App Shell
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(event.request)
        .then((networkResponse) => {
          if (
            networkResponse &&
            networkResponse.status === 200 &&
            networkResponse.type === 'basic'
          ) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          // Si falla la navegación estando offline, devolver index.html en caché
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          return new Response('Recurso no disponible sin conexión.', {
            status: 503,
            statusText: 'Offline'
          });
        });
    })
  );
});
