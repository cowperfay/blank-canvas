// Keeps Tonight opening instantly (and offline), while always preferring the newest version.
const CACHE = "tonight-v1";
const SHELL = ["./", "index.html", "styles.css", "app.js", "manifest.webmanifest", "fonts/figtree.woff2", "fonts/bricolage.woff2", "icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return; // show data & posters go straight to the network
  const isStatic = /\.(woff2|png)$/.test(url.pathname);
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(event.request, { ignoreSearch: true });
      if (isStatic && hit) return hit;
      try {
        const fresh = await fetch(event.request, { cache: "no-cache" });
        if (fresh.ok) cache.put(event.request, fresh.clone());
        return fresh;
      } catch (err) {
        if (hit) return hit;
        throw err;
      }
    })(),
  );
});
