/* Service worker. Caches the app's own files (the "shell") so it opens instantly and offline.
   It never touches Supabase requests: those are cross-origin and left alone, so game data is always live.
   Push notification handlers are added in Phase 4. */
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
