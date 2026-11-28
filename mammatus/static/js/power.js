// Is the device running on its battery? Where the browser says (the Battery Status API: Chromium on
// laptops and Android), ambient animation is held to a lower frame rate and idles sooner while unplugged.
// Elsewhere (Safari, Firefox) this stays false and the battery-saver setting alone decides.
const listeners = new Set();
let unplugged = false;

export const onBattery = () => unplugged;
export function onPowerChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

try {
  navigator.getBattery?.().then((b) => {
    const update = () => {
      const next = !b.charging && b.level < 0.995;
      if (next === unplugged) return;
      unplugged = next;
      for (const fn of listeners) { try { fn(unplugged); } catch { /* a listener's problem */ } }
    };
    b.addEventListener("chargingchange", update);
    update();
  }).catch(() => {});
} catch { /* not offered */ }
