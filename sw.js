// sw.js — app-shell cache-first with background refresh. Never touches cross-origin
// requests (the GAS API and Google Fonts) so the API always goes over the network.
'use strict';
var CACHE_NAME = 'shiftlog-v6';
var SHELL_FILES = [
  './',
  './index.html',
  './app.js',
  './logic.js',
  './styles.css',
  './config.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      // cache:'reload' bypasses the browser HTTP cache (GitHub Pages sends max-age=600),
      // otherwise a new SW could re-cache the OLD app files
      return cache.addAll(SHELL_FILES.map(function (u) { return new Request(u, { cache: 'reload' }); }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.filter(function (n) { return n !== CACHE_NAME; }).map(function (n) { return caches.delete(n); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never intercept the API or Google Fonts

  // Network-first for the app shell (so a new release shows on the next open), falling back to
  // the cache when offline or when the network takes longer than 3 s. Data stays local-first in app.js.
  event.respondWith(
    caches.match(req).then(function (cached) {
      var networkFetch = fetch(new Request(req, { cache: 'no-cache' })).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      });
      if (!cached) return networkFetch;
      var timeout = new Promise(function (resolve) { setTimeout(function () { resolve(cached); }, 3000); });
      return Promise.race([networkFetch.catch(function () { return cached; }), timeout]);
    })
  );
});
