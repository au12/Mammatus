// The Mammatus mark: a billowing cloud deck with rows of pouch-shaped lobes hanging beneath it,
// lit from below like mammatus at sunset. Lobes "form" (grow downward) with a staggered spring.

// A lobe hanging from y: elliptical belly from x1 to x2, depth = (x2-x1)/2 * k.
const lobe = (x1, x2, y, k = 1) => {
  const rx = (x2 - x1) / 2;
  return `M${x1} ${y} A${rx} ${(rx * k).toFixed(2)} 0 0 0 ${x2} ${y} Z`;
};

const BASE = "M8.5 27.5C5 27.5 4.2 23.2 7.4 21.9C7.2 17.6 11.6 15.6 15.2 17.1C16.6 12.6 23.2 11.4 26.4 14.6C28.9 10.4 36.4 10 38.9 14.2C42 11.6 48.4 12.6 49.6 16.8C53.6 15.7 58.4 18.3 57.3 22.2C60.2 23.3 59.6 27.5 55.8 27.5Z";

const LOBES_BACK = [[13.6, 25.8, 26.6, 0.92, 0.38], [25.6, 37.8, 26.6, 0.96, 0.5], [37.6, 49.8, 26.6, 0.92, 0.62]];
const LOBES_FRONT = [[6.6, 19.8, 27.3, 0.98, 0.04], [18.6, 32.2, 27.3, 1.08, 0.14], [31, 44.6, 27.3, 1.1, 0.24], [43.4, 57, 27.3, 0.98, 0.32]];

function inner(id) {
  return `<defs>
    <linearGradient id="${id}b" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#565499"/><stop offset=".55" stop-color="#3a3a7e"/><stop offset="1" stop-color="#2e2e6a"/>
    </linearGradient>
    <radialGradient id="${id}f" cx=".55" cy="1" r="1.05">
      <stop offset="0" stop-color="#ffe6c2"/><stop offset=".26" stop-color="#ffb3a7"/><stop offset=".56" stop-color="#b08ce4"/><stop offset=".9" stop-color="#3d3b84"/><stop offset="1" stop-color="#2e2e6a"/>
    </radialGradient>
    <radialGradient id="${id}k" cx=".55" cy="1" r="1.05">
      <stop offset="0" stop-color="#f0ada3"/><stop offset=".45" stop-color="#8a74c6"/><stop offset=".9" stop-color="#34337a"/><stop offset="1" stop-color="#2b2b64"/>
    </radialGradient>
    <linearGradient id="${id}h" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <g class="mm-base"><path d="${BASE}" fill="url(#${id}b)"/><path d="${BASE}" fill="url(#${id}h)"/></g>
  <g class="mm-back">${LOBES_BACK.map(([a, b, y, k, d]) => `<path class="mm-lobe" style="--d:${d}s" d="${lobe(a, b, y, k)}" fill="url(#${id}k)"/>`).join("")}</g>
  <g class="mm-front">${LOBES_FRONT.map(([a, b, y, k, d]) => `<path class="mm-lobe" style="--d:${d}s" d="${lobe(a, b, y, k)}" fill="url(#${id}f)"/>`).join("")}</g>`;
}

let seq = 0;
export function logoSVG({ size = 32, animate = true, cls = "", title = "" } = {}) {
  const id = `mm${(seq++).toString(36)}`;
  return `<svg class="mm-logo${animate ? " mm-anim" : ""} ${cls}" viewBox="2 6 60 40" width="${size}" height="${Math.round(size * 2 / 3)}" ${title ? `role="img" aria-label="${title}"` : 'aria-hidden="true"'}>${inner(id)}</svg>`;
}

// Full app icon (rounded square, twilight sky). Used to render PNG icons.
export function iconSVG({ maskable = false } = {}) {
  const s = maskable ? 0.64 : 0.8;
  // content spans x 4..60, y 10..43; center it
  const cx = 32, cy = 26.5;
  const tx = 32 - cx * s, ty = 33 - cy * s;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="512" height="512">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#080a1f"/><stop offset=".55" stop-color="#1a1b47"/><stop offset="1" stop-color="#46305f"/>
    </linearGradient>
    <radialGradient id="glow" cx=".5" cy="1.08" r=".78">
      <stop offset="0" stop-color="#ff9a6a" stop-opacity=".7"/><stop offset=".55" stop-color="#e2708a" stop-opacity=".18"/><stop offset="1" stop-color="#e2708a" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="64" height="64" rx="${maskable ? 0 : 14}" fill="url(#sky)"/>
  <rect width="64" height="64" rx="${maskable ? 0 : 14}" fill="url(#glow)"/>
  <g fill="#fff"><circle cx="10.5" cy="8.5" r=".5" opacity=".75"/><circle cx="53" cy="7" r=".4" opacity=".6"/><circle cx="47" cy="12.5" r=".3" opacity=".5"/><circle cx="19" cy="5" r=".3" opacity=".5"/><circle cx="57" cy="15" r=".25" opacity=".4"/></g>
  <g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${s})">${inner("i")}</g>
</svg>`;
}
