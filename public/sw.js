// Service worker : permet de lancer l'app sans connexion une fois installee (PWA).
// Necessite HTTPS (ou localhost). Change VERSION pour forcer le rafraichissement du cache.
const VERSION = 'vf-v1';
const SHELL = [
  '/',
  '/jeu.css',
  '/jeu.js',
  '/manifest.webmanifest',
  '/fonts/material-symbols-rounded.woff2',
  '/fonts/material-symbols-rounded-fill.woff2',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  // Page : reseau d'abord (contenu a jour), cache si hors-ligne.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  // Assets : cache d'abord, mis a jour en arriere-plan.
  event.respondWith(
    caches.match(req).then((cached) => {
      const refresh = fetch(req).then((res) => {
        if (res.ok) caches.open(VERSION).then((cache) => cache.put(req, res.clone()));
        return res;
      }).catch(() => cached);
      return cached || refresh;
    })
  );
});
