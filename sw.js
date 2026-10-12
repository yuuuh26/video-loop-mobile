const CACHE = 'yuu-video-loop-mobile-shell-v1.0.0';
const PREFIX = 'yuu-video-loop-mobile-shell-';
const BASE = new URL('./', self.location.href);
const ASSETS = ['index.html', 'style.css', 'app.js', 'player.js', 'storage.js', 'backup.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-192.png', 'icons/maskable-512.png'];
const ALLOWED = new Set(ASSETS.map(path => new URL(path, BASE).href));
ALLOWED.add(BASE.href);

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(ASSETS.map(path => new Request(new URL(path, BASE), { cache: 'reload', credentials: 'omit' })));
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(PREFIX) && name !== CACHE).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});
self.addEventListener('message', event => {
  if (event.data?.type === 'ACTIVATE_UPDATE') self.skipWaiting();
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== BASE.origin || !url.pathname.startsWith(BASE.pathname)) return;
  if (url.search || !ALLOWED.has(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const target = url.href === BASE.href ? new URL('index.html', BASE).href : url.href;
    const cached = await cache.match(target);
    if (cached) return cached;
    // Only application assets reach this point, never user videos or filenames.
    return fetch(new Request(target, { cache: 'no-cache', credentials: 'omit' }));
  })());
});
