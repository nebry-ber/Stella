/**
 * sw.js — Service worker: rende l'app utilizzabile offline.
 *
 * Tutti i file dell'app vengono messi in cache all'installazione e serviti
 * dalla cache ("cache first"). I dati NON passano di qui: stanno in IndexedDB.
 *
 * Quando si pubblica una modifica, aumentare VERSION: i dispositivi
 * scaricheranno i nuovi file e l'app mostrerà "È disponibile una nuova versione".
 */

const VERSION = 'v1.4.4';
const CACHE = `bucaneve-${VERSION}`;

// Percorsi relativi: funzionano anche in una sottocartella (es. utente.github.io/Stella/)
const FILES = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/store.js',
  './js/model.js',
  './js/db.js',
  './js/sync.js',
  './js/admin.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('bucaneve-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// L'app chiede di attivare subito la nuova versione quando l'utente tocca "Aggiorna".
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Le API del server non passano mai dalla cache
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // Le navigazioni (apertura dell'app) ricevono sempre index.html dalla cache.
    const cached = await cache.match(req, { ignoreSearch: true })
      || (req.mode === 'navigate' ? await cache.match('./index.html') : undefined);
    if (cached) return cached;
    try {
      return await fetch(req);
    } catch {
      return new Response('Non disponibile offline', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
