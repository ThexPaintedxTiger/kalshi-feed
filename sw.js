// Service worker: makes the dashboard installable and lets it open offline with the last data it saw.
// Page shell: cache first, refreshed in the background. Data (.json): network first, cached copy only when offline.
const C = "kalshi-v2";
self.addEventListener("install", e => { e.waitUntil(caches.open(C).then(c => c.addAll(["./", "index.html", "icon.svg", "manifest.webmanifest"]).catch(() => {})).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || u.pathname.endsWith("/events") || u.pathname.includes("/api/")) return;
  const put = r => { if (r.ok) { const cp = r.clone(); caches.open(C).then(c => c.put(e.request, cp)); } return r; };
  if (u.pathname.endsWith(".json")) e.respondWith(fetch(e.request).then(put).catch(() => caches.match(e.request)));
  else e.respondWith(caches.match(e.request).then(hit => { const net = fetch(e.request).then(put).catch(() => hit); return hit || net; }));
});
