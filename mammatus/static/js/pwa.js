// Service worker registration, install prompt and Web Push subscription.
import { post } from "./api.js";

let reg = null;
let deferredInstall = null;

export async function register(onUpdate) {
  if (!("serviceWorker" in navigator)) return null;
  try {
    reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    reg.addEventListener("updatefound", () => {
      const w = reg.installing;
      w?.addEventListener("statechange", () => { if (w.state === "installed" && navigator.serviceWorker.controller) onUpdate?.(); });
    });
    // check for updates when the app comes back to the foreground (cheap: one conditional request)
    document.addEventListener("visibilitychange", () => { if (!document.hidden) reg.update().catch(() => {}); });
  } catch { reg = null; }
  return reg;
}

export function onMessage(fn) {
  navigator.serviceWorker?.addEventListener("message", (e) => fn(e.data));
}

window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferredInstall = e; document.dispatchEvent(new Event("mm-installable")); });
export const canInstall = () => !!deferredInstall;
export async function install() {
  if (!deferredInstall) return false;
  deferredInstall.prompt();
  const r = await deferredInstall.userChoice;
  deferredInstall = null;
  return r.outcome === "accepted";
}
export const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

export function pushSupport() {
  if (!window.isSecureContext) return { ok: false, reason: "Push needs HTTPS. Open Mammatus through your reverse proxy's https:// address." };
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    if (isIOS() && !isStandalone()) return { ok: false, reason: "On iPhone and iPad, tap Share → Add to Home Screen, then open Mammatus from the home screen to turn on notifications." };
    return { ok: false, reason: "This browser doesn't support push notifications." };
  }
  if (Notification.permission === "denied") return { ok: false, reason: "Notifications are blocked for this site. Allow them in your browser's site settings." };
  return { ok: true };
}

async function ready() {
  if (!reg) reg = await navigator.serviceWorker.getRegistration("/") || await register();
  if (!reg) throw new Error("The service worker isn't available.");
  return navigator.serviceWorker.ready;
}

export async function currentSubscription() {
  if (!pushSupport().ok) return null;
  try { return await (await ready()).pushManager.getSubscription(); } catch { return null; }
}

const b64ToBytes = (b64) => {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) || isIOS() ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Linux";
  const br = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : "Safari";
  return `${br} on ${os}${isStandalone() ? " (app)" : ""}`;
}

export async function subscribe(vapidKey) {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Permission was not granted.");
  const r = await ready();
  let sub = await r.pushManager.getSubscription();
  const key = b64ToBytes(vapidKey);
  if (sub) {
    const cur = sub.options?.applicationServerKey;
    if (cur && new Uint8Array(cur).join() !== key.join()) { await sub.unsubscribe(); sub = null; }
  }
  sub ||= await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const json = sub.toJSON();
  await post("/push/subscribe", { endpoint: json.endpoint, keys: json.keys, label: deviceLabel() });
  return sub;
}

export async function unsubscribe() {
  const sub = await currentSubscription();
  if (!sub) return;
  await post("/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}

// Keep the server's copy fresh (endpoints can rotate).
export async function resync() {
  const sub = await currentSubscription();
  if (!sub) return;
  const json = sub.toJSON();
  post("/push/subscribe", { endpoint: json.endpoint, keys: json.keys, label: deviceLabel() }).catch(() => {});
}
