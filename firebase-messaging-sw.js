// firebase-messaging-sw.js
// Этот файл ДОЛЖЕН лежать в КОРНЕ вашего сайта по адресу:
// https://ваш-домен/firebase-messaging-sw.js

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyAfNoV7tt_6eP1gRQxLc4Yk5FJzwVxDMQw",
  authDomain: "game-cd07d.firebaseapp.com",
  databaseURL: "https://game-cd07d-default-rtdb.firebaseio.com",
  projectId: "game-cd07d",
  storageBucket: "game-cd07d.firebasestorage.app",
  messagingSenderId: "1001558545053",
  appId: "1:1001558545053:web:b99f86362c1b93aad13a74"
});

const messaging = firebase.messaging();
const ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxOTIgMTkyIj48cmVjdCB3aWR0aD0iMTkyIiBoZWlnaHQ9IjE5MiIgcng9IjQwIiBmaWxsPSIjODc3NGUxIi8+PHBhdGggZD0iTTQ4IDk2YzAtMjYgMjItNDggNDgtNDhzNDggMjIgNDggNDgtMjIgNDgtNDggNDgtNDgtMjItNDgtNDh6IiBmaWxsPSIjZmZmIi8+PC9zdmc+';

self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// >>> ЭТО ГЛАВНАЯ ФУНКЦИЯ <<<
// Срабатывает, когда приходит push, а приложение ЗАКРЫТО или в фоне
messaging.onBackgroundMessage((payload) => {
  console.log('[SW] Background message:', payload);
  const n = payload.notification || {};
  const d = payload.data || {};
  const title = n.title || 'Flux';
  const body = n.body || 'Новое сообщение';

  self.registration.showNotification(title, {
    body: body,
    icon: ICON,
    badge: ICON,
    vibrate: [200, 100, 200],
    tag: d.chatId ? ('flux-' + d.chatId) : ('flux-' + Date.now()),
    renotify: true,
    data: d
  });
});

// Клик по уведомлению — открыть приложение на нужном чате
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  const url = data.chatId
    ? ('/?chat=' + encodeURIComponent(data.chatId))
    : '/';

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          try { c.navigate(url); } catch (_) {}
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
