const CACHE_NAME = 'ememory-cache-v5';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './settings.html',
  './style.css',
  './app.js',
  './settings.js',
  './manifest.json',
  './vendor/jszip.min.js',
  './vendor/sql-wasm.js',
  './vendor/sql-wasm.wasm',
  './icons/icon-192x192.png',
  './icons/icon-512x512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('Service Worker: caching app shell');
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request).catch(() =>
        new Response('Offline – resource not available.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain' }
        })
      );
    })
  );
});
