/* Dais Supervisor PWA — service worker.
 * T117 / TASK-DAIS-PWA-IPHONE-AGENT-DASHBOARD
 * T125 / TASK-DAIS-PWA-ROOT-URL-CONSOLIDATION
 * DA153-OPS_P / TASK-DAIS-PHASE3-T4-EMERGENCY-NOTIFICATION (P3-T4)
 *
 * 戦略:
 *   - static shell (PWA HTML / CSS / JS / icons / manifest) = cache-first
 *   - JSON endpoint + progress iframe HTML (t_progress.html) = network-first, fallback to cache
 *   - service worker は offline でも shell が起動し、 直近 fetch 済み JSON を表示できる
 *   - precache list は 相対 path (./) のみ使用、 root + /pwa/ 双方の scope で 自動成立
 *     (T125 URL 1 本化、 root URL アクセス で PWA がそのまま表示)
 *
 * push 通知 (T122 / P3-T4) との連携:
 *   - 'push' handler: Web Push API の event.data から
 *     { title, body, deeplink, id, ts } を読み notification を表示する
 *     (scripts/devs_emergency_notify.sh が emit する payload schema)。
 *   - 'notificationclick' handler: 通知 tap で deeplink を新規 / 既存 client window に
 *     focus / openWindow する。
 *   - Apple Developer 加入 + VAPID key 配備後に Web Push 配信が有効化される。
 *     gateway 経由で direct push できない環境では 'message' event 経由で
 *     PWA が emergency_notify_queue.json を読み込み手動で showNotification する
 *     fallback 経路 (= P3-T4 デモ経路) が利用される。
 */

var CACHE_VERSION = 'dais-pwa-v5-2026-05-10-da153';
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

// ─── P3-T4 emergency push 通知 (T122 + DA153-OPS_P) ─────────────────────
// payload schema (scripts/devs_emergency_notify.sh と一致):
//   { title: string, body: string, deeplink: string, id: string, ts: ISO }
// urgency は emergency 固定 (= aggregator 側で gate 済)。
// tag は 同じ id の重複表示を抑制するため id を流用する。
self.addEventListener('push', function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Dais', body: event.data ? event.data.text() : '' };
  }
  var title = data.title || 'PO judgement needed';
  var deeplink = data.deeplink || data.url || './index.html';
  var options = {
    body: data.body || '緊急 PO 判断が必要です。',
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: data.id || data.tag || 'dais-urgent',
    requireInteraction: true,
    data: {
      url: deeplink,
      id: data.id || '',
      ts: data.ts || ''
    }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// notification click: deeplink (= /pwa/po-decision.html?id=<ID>) を開く。
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

// fallback path: VAPID 配備前は PWA 側 JS が emergency_notify_queue.json を
// fetch し、 SW へ postMessage({type:'emergency_payload', payload:{...}}) で
// showNotification を依頼する。 同じ payload schema を期待する。
self.addEventListener('message', function (event) {
  var msg = (event && event.data) || {};
  if (msg.type !== 'emergency_payload' || !msg.payload) return;
  var p = msg.payload;
  var title = p.title || 'PO judgement needed';
  var options = {
    body: p.body || '緊急 PO 判断が必要です。',
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: p.id || 'dais-urgent',
    requireInteraction: true,
    data: { url: p.deeplink || './index.html', id: p.id || '', ts: p.ts || '' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
