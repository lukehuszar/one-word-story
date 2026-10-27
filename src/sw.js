/* Service worker. Caches the app's own files (the "shell") so it opens instantly and offline.
   It never touches Supabase requests: those are cross-origin and left alone, so game data is always live.
   Also shows push notifications and opens the right story when one is tapped. */
import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Any page navigation gets the cached index.html (single-page app), except files that have their own URL.
registerRoute(new NavigationRoute(createHandlerBoundToURL("/index.html")));

// The page asks the waiting worker to take over when the user taps "Update".
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

// ───────── Push notifications ─────────
// iOS cancels a push subscription if a push arrives and no visible notification is shown,
// so this ALWAYS calls showNotification, even if the app is open.
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch { data = { body: event.data ? event.data.text() : "" }; }
  event.waitUntil(
    self.registration.showNotification(data.title || "One Word Story", {
      body: data.body || "",
      tag: data.tag || undefined,
      renotify: !!data.tag,          // a newer message for the same story still alerts
      icon: "/icon-192.png",
      data: { url: data.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin);
  const gameId = url.searchParams.get("game");
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const win = wins.find((w) => w.url.startsWith(self.location.origin));
    if (win) {
      await win.focus();
      if (gameId) win.postMessage({ type: "OPEN_GAME", gameId });
    } else {
      await self.clients.openWindow(url.href);
    }
  })());
});
