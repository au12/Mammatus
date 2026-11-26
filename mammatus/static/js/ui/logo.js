// The Mammatus mark: the underside of a mammatus deck at sunset, looking toward the horizon.
//
// The artwork is generated, not drawn: a seeded dart-throwing pass packs pouches of random sizes
// onto the cloud base in perspective (big overhead at the top, small toward the horizon), sorts
// them far-to-near and shades each one for a low sun at the bottom left. Every pouch is its own
// group, so CSS can let them form, sag and wobble independently (see css/logo.css).

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const n1 = (v) => String(Math.round(v * 10) / 10);
const n2 = (v) => String(Math.round(v * 100) / 100);

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SUN = [23, 95];   // on the horizon, lower left of the 100 x 100 tile
const HILLS = "M0 94.5C8 93.2 14 94.6 22 95.4C31 96.3 37 93.4 46 92.6C56 91.7 62 94.2 71 94.4C81 94.6 89 91.6 100 92.2V100H0Z";

// Two levels of detail: the full field for icons and large marks, a bolder one for tiny sizes.
const FIELDS = {
  full: { seed: 17, top: -4, bottom: 85, rNear: 15.5, rFar: 4.4, pow: 1.12, cNear: 0.7, cFar: 0.4, k: 0.94, tall: 1.25, flat: 0.26, wide: 2.3, lumps: 8,
    passes: [[30, 1.15, 1.4], [500, 0.8, 1.08], [700, 0.5, 0.7]] },
  small: { seed: 8, top: -4, bottom: 78, rNear: 22, rFar: 8, pow: 1.05, cNear: 0.7, cFar: 0.55, k: 0.94, tall: 1.25, flat: 0.55, wide: 1.3, lumps: 99,
    passes: [[20, 1.1, 1.3], [300, 0.82, 1.05], [400, 0.5, 0.7]] },
};

// Pack pouches by dart throwing with a perspective-dependent size and vertical squash.
// (x, y) is the centre of a pouch's rounded bottom; its body extends upward from there.
export function pouchField(o) {
  const R = mulberry32(o.seed);
  const depth = (y) => clamp01((y - o.top) / (o.bottom - o.top));   // 0 overhead .. 1 horizon
  const size = (y) => o.rFar + (o.rNear - o.rFar) * Math.pow(1 - depth(y), o.pow);
  const P = [];
  for (const [tries, lo, hi] of o.passes) {
    for (let i = 0; i < tries; i++) {
      const y = lerp(o.top, o.bottom, R());
      const r = size(y) * lerp(lo, hi, R());
      const x = lerp(-0.5 * r, 100 + 0.5 * r, R());
      let ok = true;
      for (const q of P) {
        const c = lerp(o.cNear, o.cFar, depth((y + q.y) / 2));
        const dx = x - q.x, dy = (y - q.y) / c, need = o.k * (r + q.r);
        if (dx * dx + dy * dy < need * need) { ok = false; break; }
      }
      if (ok) P.push({ x, y, r });
    }
  }
  for (const p of P) {
    const d = depth(p.y);
    // overhead pouches hang like bulbs; toward the horizon they are seen edge-on and flatten
    p.rx = p.r * lerp(0.96, 1.1, R()) * lerp(1, o.wide, d * d * d);
    p.ry = p.r * lerp(o.tall, o.flat, Math.pow(d, 1.2)) * lerp(0.94, 1.08, R());
    p.cy = p.y + p.r - p.ry;
    // lumps: big pouches carry smaller bulges on their underside
    p.kids = [];
    const nk = p.r > o.lumps ? 1 + (R() < 0.6 ? 1 : 0) + (R() < 0.25 ? 1 : 0) : 0;
    for (let k = 0; k < nk; k++) {
      const a = (R() < 0.5 ? -1 : 1) * lerp(18, 70, R()) * Math.PI / 180, dist = lerp(0.6, 0.95, R());
      const kr = p.r * lerp(0.36, 0.56, R()), kry = kr * (p.ry / p.r) * 0.9;
      const ky = p.y + Math.cos(a) * dist * p.r * 0.55;
      p.kids.push({ x: p.x + Math.sin(a) * dist * p.rx, y: ky, r: kr, rx: kr * 1.05, ry: kry, cy: ky + kr - kry });
    }
    // light: golden and hazy near the sun, deep red with purple shadows far from it
    const lp = 1 - clamp01(Math.hypot(p.x - SUN[0], p.y - SUN[1]) / 112);
    p.tier = Math.max(0, Math.min(3, Math.round(lp * 4.3 - 0.6 + (R() - 0.5) * 1.1)));
    if (p.tier < 3 && R() < 0.22) p.tier = "r";   // a few rose-red ones
    // animation: forms outward from the sun, then each pouch keeps its own rhythm
    p.delay = 0.08 + Math.hypot(p.x - SUN[0], p.y - SUN[1]) / 165 + R() * 0.16;
    p.dur = lerp(2.6, 5.6, R());
    p.amp = p.r * lerp(0.1, 0.2, R());
    p.kind = R() < 0.4 ? "a" : R() < 0.6 ? "b" : "c";
    p.attach = p.y - p.r;
    p.far = d > 0.74;   // streaks in the haze: no contact shadow, no wobble
  }
  return P.sort((a, b) => b.y - b.r * 0.4 - (a.y - a.r * 0.4));   // far (low on the tile) first
}

// A pouch is lit from below: a ramp along the light direction, brightest at the lower rim and
// dissolving upward into the dark cloud base (a ball lit from underneath shades exactly so).
const LOBE_STOPS = [0.16, 0.36, 0.52, 0.64, 0.77, 0.88, 0.96, 1];
const LOBE_ALPHA = [0, 0.4, 0.86, 1, 1, 1, 1, 1];
const LUMP_ALPHA = [0, 0, 0, 0.45, 0.95, 1, 1, 1];
const LOBES = {
  0: ["#4a1232", "#641634", "#8e2036", "#bb3034", "#de5030", "#f47c3a", "#ffb062", "#ffd08e"],
  1: ["#541432", "#701834", "#9c2436", "#c83832", "#e85a30", "#f98840", "#ffbe74", "#ffdc9c"],
  2: ["#641834", "#842036", "#b03034", "#da4c30", "#f26e34", "#fd9a48", "#ffca80", "#ffe6ac"],
  3: ["#8a2a36", "#a43836", "#d05232", "#ee7236", "#fb9442", "#ffb65c", "#ffd890", "#fff0c4"],
  r: ["#56143a", "#74183e", "#a22442", "#cc3644", "#e85648", "#f9845c", "#ffb68a", "#ffd6ae"],
};
// Contact shadow under each pouch.
const SHADE = [[0, "#220a26", 0.78], [0.6, "#2e0c26", 0.46], [1, "#2e0c26", 0]];

const stops = (list) => list.map(([o, c, a]) => `<stop offset="${o}" stop-color="${c}"${a == null ? "" : ` stop-opacity="${a}"`}/>`).join("");

function defs(id, rx) {
  return `<defs>
<clipPath id="${id}c"><rect width="100" height="100" rx="${rx}"/></clipPath>
<linearGradient id="${id}s" x1=".42" y1="0" x2=".5" y2="1">${stops([[0, "#2a1238"], [0.24, "#461030"], [0.5, "#74192c"], [0.7, "#b23c2a"], [0.86, "#ee8236"], [1, "#ffbc5c"]])}</linearGradient>
${Object.entries(LOBES).map(([k, t]) => `<linearGradient id="${id}b${k}" x1=".72" y1="0" x2=".3" y2="1">${stops(t.map((c, i) => [LOBE_STOPS[i], c, LOBE_ALPHA[i]]))}</linearGradient>`
    + `<linearGradient id="${id}k${k}" x1=".72" y1="0" x2=".3" y2="1">${stops(t.map((c, i) => [LOBE_STOPS[i], c, LUMP_ALPHA[i]]).slice(2))}</linearGradient>`).join("\n")}
<radialGradient id="${id}a">${stops(SHADE)}</radialGradient>
<radialGradient id="${id}u" gradientUnits="userSpaceOnUse" cx="${SUN[0]}" cy="${SUN[1]}" r="66">${stops([[0, "#fff8d8", 1], [0.12, "#ffe296", 0.92], [0.34, "#ffa24c", 0.5], [0.7, "#ff7038", 0.12], [1, "#ff7038", 0]])}</radialGradient>
<linearGradient id="${id}z" x1="0" y1="0" x2="0" y2="1">${stops([[0.62, "#ff9a48", 0], [0.86, "#ffae52", 0.5], [1, "#ffc870", 0.8]])}</linearGradient>
<linearGradient id="${id}l" x1="0" y1="0" x2="1" y2="0">${stops([[0, "#5e1c38"], [0.23, "#7a2a36"], [0.5, "#3c1546"], [1, "#1a1c54"]])}</linearGradient>
<radialGradient id="${id}d">${stops([[0, "#fffdf0", 1], [0.7, "#fff0b4", 1], [1, "#ffe08a", 0.9]])}</radialGradient>
<radialGradient id="${id}e">${stops([[0, "#fff2c0", 0.7], [0.4, "#ffc878", 0.3], [1, "#ffa050", 0]])}</radialGradient>
<radialGradient id="${id}v" gradientUnits="userSpaceOnUse" cx="104" cy="-4" r="60">${stops([[0, "#141a5c", 0.8], [0.5, "#241452", 0.34], [1, "#241452", 0]])}</radialGradient>
</defs>`;
}

function lobe(id, p, tier, lump) {
  const body = `<ellipse cx="${n1(p.x)}" cy="${n1(p.cy)}" rx="${n1(p.rx)}" ry="${n1(p.ry)}" fill="url(#${id}${lump ? "k" : "b"}${tier})"/>`;
  if (lump || p.far) return body;
  return `<ellipse cx="${n1(p.x + 0.05 * p.r)}" cy="${n1(p.y + 0.3 * p.r)}" rx="${n1(1.2 * p.rx)}" ry="${n1(1.05 * p.r)}" fill="url(#${id}a)"/>` + body;
}

function pouches(id, field) {
  return field.map((p) => {
    const style = `transform-origin:${n1(p.x)}px ${n1(p.attach)}px;--d:${n2(p.delay)}s;--t:${n2(p.dur)}s;--y:${n2(p.amp)}px`;
    return `<g class="mm-p mm-${p.far ? "far" : p.kind}" style="${style}">${lobe(id, p, p.tier)}${p.kids.map((k) => lobe(id, k, p.tier, true)).join("")}</g>`;
  }).join("\n");
}

let seq = 0;

// The artwork as SVG markup. opts: {detail: full|small, round: corner radius (0..50), seed}
export function artSVG(id, opts = {}) {
  const cfg = { ...FIELDS[opts.detail || "full"] };
  if (opts.seed != null) cfg.seed = opts.seed;
  const rx = opts.round ?? 22.5;
  const field = pouchField(cfg);
  return `${defs(id, rx)}
<g clip-path="url(#${id}c)">
<rect class="mm-sky" width="100" height="100" fill="url(#${id}s)"/>
<g class="mm-field">
${pouches(id, field)}
</g>
<rect class="mm-haze" width="100" height="100" fill="url(#${id}z)"/>
<g class="mm-sun"><circle cx="${SUN[0]}" cy="${SUN[1]}" r="66" fill="url(#${id}u)"/><circle cx="${SUN[0]}" cy="${SUN[1]}" r="3.4" fill="url(#${id}d)"/></g>
<path class="mm-land" d="${HILLS}" fill="url(#${id}l)"/>
<circle class="mm-flare" cx="${SUN[0]}" cy="${SUN[1] + 0.6}" r="13" fill="url(#${id}e)"/>
<circle class="mm-vig" cx="104" cy="-4" r="78" fill="url(#${id}v)"/>
${rx ? `<rect x=".4" y=".4" width="99.2" height="99.2" rx="${n1(rx - 0.4)}" fill="none" stroke="#fff" stroke-opacity=".16" stroke-width=".8"/>` : ""}
</g>`;
}

// Inline logo for the app. animate: play the forming animation; loop: keep boiling afterwards
// (add cls "mm-brief" to stop after a few cycles).
export function logoSVG({ size = 32, animate = true, loop = false, cls = "", title = "", detail, seed, id = `mm${(seq++).toString(36)}_` } = {}) {
  const d = detail || (size < 64 ? "small" : "full");
  const classes = ["mm-logo", animate ? "mm-anim" : "", loop ? "mm-loop" : "", cls].filter(Boolean).join(" ");
  return `<svg class="${classes}" viewBox="0 0 100 100" width="${size}" height="${size}" ${title ? `role="img" aria-label="${title}"` : 'aria-hidden="true"'}>${artSVG(id, { detail: d, seed })}</svg>`;
}

// Standalone icon. maskable: full-bleed square for Android adaptive icons and iOS.
export function iconSVG({ maskable = false, detail = "full", size = 512, seed } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}">${artSVG("i", { detail, seed, round: maskable ? 0 : 22.5 })}</svg>`;
}
