// Mammatus service worker: offline shell, asset caching, Web Push.
// The build replaces the precache list and version below.
const VERSION = "dev";
const PRECACHE = ["/", "/css/app.css", "/js/main.js"];
const SHELL = `mm-shell-${VERSION}`;
const STATIC = "mm-static-v1";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("mm-shell-") && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // API traffic goes straight to the network (frames are immutable and HTTP-cached already).
  if (url.pathname.startsWith("/api/")) return;
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(SHELL).then((c) => c.put("/", copy)); }
      return r;
    }).catch(() => caches.match("/", { ignoreSearch: true })));
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); }
      return r;
    })));
    return;
  }
  if (/^\/(img|data|icons)\//.test(url.pathname)) {
    e.respondWith(caches.open(STATIC).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});

self.addEventListener("push", (e) => {
  let msg = {};
  try { msg = e.data ? e.data.json() : {}; } catch { msg = { title: "Mammatus", body: e.data?.text() || "" }; }
  const title = msg.title || "Mammatus";
  const severe = msg.kind === "nws" || msg.urgency === "high";
  const opts = {
    body: msg.body || "",
    tag: msg.tag || undefined,
    renotify: !!msg.tag && severe,
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-96.png",
    data: { url: msg.data?.url || "/", id: msg.id },
    timestamp: Date.now(),
    requireInteraction: msg.kind === "nws" && /Warning/.test(title),
    vibrate: severe ? [120, 60, 120] : undefined,
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = e.notification.data?.url || "/";
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === location.origin) {
        await w.focus();
        w.postMessage({ type: "open", url });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});

self.addEventListener("pushsubscriptionchange", (e) => {
  e.waitUntil((async () => {
    const opts = e.oldSubscription?.options;
    if (!opts?.applicationServerKey) return;
    const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: opts.applicationServerKey });
    const json = sub.toJSON();
    await fetch("/api/push/subscribe", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Mammatus": "1" },
      body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, label: "Renewed subscription" }),
    });
  })());
});
