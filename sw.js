/* Dais Supervisor PWA — service worker.
 * T117 / TASK-DAIS-PWA-IPHONE-AGENT-DASHBOARD
 * T125 / TASK-DAIS-PWA-ROOT-URL-CONSOLIDATION
 *
 * 戦略:
 *   - static shell (PWA HTML / CSS / JS / icons / manifest) = cache-first
 *   - JSON endpoint + progress iframe HTML (t_progress.html) = network-first, fallback to cache
 *   - service worker は offline でも shell が起動し、 直近 fetch 済み JSON を表示できる
 *   - precache list は 相対 path (./) のみ使用、 root + /pwa/ 双方の scope で 自動成立
 *     (T125 URL 1 本化、 root URL アクセス で PWA がそのまま表示)
 *
 * push 通知 (T122) との連携:
 *   - 'push' / 'notificationclick' handler は placeholder。 Apple Developer 加入 +
 *     VAPID key 配備後に有効化される。
 */

var CACHE_VERSION = 'dais-pwa-v4-2026-05-09-t144';
var STATIC_CACHE = CACHE_VERSION + '-static';
var DATA_CACHE = CACHE_VERSION + '-data';

var STATIC_ASSETS = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(function (cache) {
      return cache.addAll(STATIC_ASSETS).catch(function (err) {
        // icon が無い等の partial failure は致命傷にしない
        console.warn('sw install: addAll partial fail:', err);
      });
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== STATIC_CACHE && k !== DATA_CACHE) {
          return caches.delete(k);
        }
        return null;
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);

  // JSON endpoints + progress iframe HTML: network-first
  var isJsonData = /\.json$/.test(url.pathname);
  var isProgressHtml = /\/t_progress\.html$/.test(url.pathname);
  var isNetworkFirst = isJsonData || isProgressHtml;

  if (isNetworkFirst) {
    event.respondWith(
      fetch(req).then(function (resp) {
        var copy = resp.clone();
        caches.open(DATA_CACHE).then(function (cache) {
          cache.put(req, copy).catch(function () {});
        });
        return resp;
      }).catch(function () {
        return caches.match(req).then(function (hit) {
          if (hit) return hit;
          if (isProgressHtml) {
            return new Response('<!doctype html><title>Dais progress offline</title><p>progress offline</p>',
              { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
          }
          return new Response(JSON.stringify({ error: 'offline', tasks: [], agents: [] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } });
        });
      })
    );
    return;
  }

  // static shell: cache-first
  event.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (resp) {
        if (resp && resp.status === 200 && resp.type === 'basic') {
          var copy = resp.clone();
          caches.open(STATIC_CACHE).then(function (cache) {
            cache.put(req, copy).catch(function () {});
          });
        }
        return resp;
      }).catch(function () {
        // offline + no cache: fall back to index.html (SPA shell)
        if (req.mode === 'navigate') {
          return caches.match('./index.html');
        }
        return new Response('', { status: 504 });
      });
    })
  );
});

// ─── push 通知 placeholder (T122 で有効化) ────────────────────────────
self.addEventListener('push', function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Dais', body: event.data ? event.data.text() : '' };
  }
  var title = data.title || 'Dais Supervisor';
  var options = {
    body: data.body || '緊急 PO 判断が必要です。',
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: data.tag || 'dais-urgent',
    data: { url: data.url || './index.html' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || './index.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(function (clients) {
      for (var i = 0; i < clients.length; i++) {
        var c = clients[i];
        if (c.url.indexOf(url) >= 0 && 'focus' in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
      return null;
    })
  );
});
