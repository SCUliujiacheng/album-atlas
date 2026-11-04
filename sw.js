/* global PRECACHE, PRECACHE_REV */
importScripts('./precache.js');
const prefix = 'album-atlas:' + self.registration.scope + ':';
const cacheName = prefix + PRECACHE_REV;
const scope = new URL(self.registration.scope);
const urls = new Set(PRECACHE.map(path => new URL(path, scope).href));

self.addEventListener('install', event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(
    [...urls].map(url => new Request(url, {cache:'reload'}))
  )));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(prefix) && key !== cacheName).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== scope.origin) return;
  let key = url.href;
  if (url.pathname === scope.pathname || url.pathname === scope.pathname + 'index.html') key = new URL('index.html', scope).href;
  if (!urls.has(key)) return;
  event.respondWith(caches.open(cacheName).then(async cache => (await cache.match(key)) || fetch(request)));
});
